import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import type { AgentEvent, HarnessCapabilities, HarnessModel } from "@agentdesk/contracts"
import {
  type ApprovalResponse,
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  isRecord,
  type PromptImage,
  type PromptOptions,
  runCommand,
  spawnManaged,
  type StartInput,
  str
} from "@agentdesk/harness-core"
import { AbsolutePath, Location, OpenCode, type OpenCodeClient } from "@opencode/client/effect"
import { Cause, Deferred, Effect, Queue, Scope, Stream } from "effect"
import { Sse } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { type OpenCodeEvent, OpenCodeNormalizer, parseEvent } from "./normalizer"
import { formAnswer, openCodeModel, openCodePermissions, parseModelLines, parseModels } from "./protocol"

export interface OpenCodeAdapterOptions {
  readonly binary?: string
  readonly startupTimeoutMs?: number
}

export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  // OpenCode 2 has no plan agent: plan denies edits instead.
  planMode: "read_only",
  acceptEdits: "native",
  liveEffort: true,
  allowForSession: true,
  questions: true,
  cost: true,
  rateLimits: false
}

/** Instruction entry holding the user's extra instructions for AgentDesk sessions. */
const INSTRUCTIONS_KEY = "agentdesk"

const protocolError = (what: string) => (cause: unknown) =>
  new HarnessError({ harness: "opencode", reason: "protocol", message: `opencode ${what}: ${errorMessage(cause)}`, cause })

const errorMessage = (e: unknown): string =>
  isRecord(e) ? (str(e.message) ?? (isRecord(e.cause) ? errorMessage(e.cause) : str(e._tag)) ?? String(e)) : String(e)

/** `opencode serve --stdio` reports its address as one JSON line; it serves until its stdin closes. */
const STDIO_URL = /^\s*\{"url":"([^"]+)"\}\s*$/

interface Server {
  readonly url: string
  readonly client: OpenCodeClient
  /** The authenticated HTTP client, for the event stream. */
  readonly http: HttpClient.HttpClient
  readonly pid: number | undefined
  readonly exited: Effect.Effect<{ code: number | null; signal: string | null }>
  readonly stderrTail: () => string
}

/**
 * One private OpenCode server per agent session: loopback only, a fresh password, rooted at the worktree,
 * and bound to the caller's scope (closing it ends the server).
 */
const startServer = (
  binary: string,
  input: { cwd: string; env?: Readonly<Record<string, string>>; sandboxPrefix?: ReadonlyArray<string> },
  startupTimeoutMs: number
): Effect.Effect<Server, HarnessError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const password = randomBytes(24).toString("base64url")
    const proc = yield* spawnManaged({
      harness: "opencode",
      sandboxPrefix: input.sandboxPrefix,
      command: binary,
      args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      cwd: input.cwd,
      // OpenCode reads the password, then removes it from the environment its tools see.
      env: { ...input.env, OPENCODE_SERVER_PASSWORD: password }
    })
    const ready = yield* Deferred.make<string, HarnessError>()
    yield* proc.lines.pipe(
      Stream.runForEach((line) => {
        const m = STDIO_URL.exec(line)
        return m ? Deferred.succeed(ready, m[1]!.replace(/\/$/, "")) : Effect.void
      }),
      Effect.andThen(
        Deferred.fail(ready, new HarnessError({ harness: "opencode", reason: "spawn_failed", message: proc.stderrTail().trim() || "opencode serve exited" }))
      ),
      Effect.forkScoped
    )
    const url = yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: startupTimeoutMs,
        orElse: () => Effect.fail(new HarnessError({ harness: "opencode", reason: "timeout", message: "opencode serve did not start" }))
      })
    )
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
    const http = yield* HttpClient.HttpClient.pipe(
      Effect.map(HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", authorization))),
      Effect.provide(FetchHttpClient.layer)
    )
    const client = yield* OpenCode.make({ baseUrl: url }).pipe(Effect.provideService(HttpClient.HttpClient, http))
    return { url, client, http, pid: proc.pid, exited: proc.exited, stderrTail: proc.stderrTail }
  })

/**
 * The server's event bus. Decoded leniently: event types this version doesn't know (OpenCode adds them
 * often) are skipped instead of ending the stream.
 */
const eventStream = (server: Server): Stream.Stream<OpenCodeEvent, HarnessError> =>
  server.http.get(`${server.url}/api/event`, { headers: { accept: "text/event-stream" } }).pipe(
    Effect.map((res) => res.stream),
    Stream.unwrap,
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.map((e) => parseEvent(e.data)),
    Stream.filter((e): e is OpenCodeEvent => e !== undefined),
    Stream.mapError((e) => new HarnessError({ harness: "opencode", reason: "io", message: `opencode event stream: ${errorMessage(e)}`, cause: e }))
  )

export const makeOpenCodeAdapter = (options: OpenCodeAdapterOptions = {}): HarnessAdapter => {
  const resolveBinary = () => options.binary ?? process.env.AGENTDESK_OPENCODE_BIN ?? findExecutable("opencode")
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000

  const launch = (input: StartInput & { providerSessionId?: string }) =>
    Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) {
        return yield* new HarnessError({ harness: "opencode", reason: "not_installed", message: "opencode CLI not found on PATH" })
      }
      const server = yield* startServer(binary, { cwd: input.cwd, env: input.policy.env, sandboxPrefix: input.policy.sandboxPrefix }, startupTimeoutMs)
      const { client } = server

      // Listen before creating or prompting the session, so nothing it does is missed.
      const raw = yield* Queue.unbounded<OpenCodeEvent, HarnessError | Cause.Done>()
      yield* eventStream(server).pipe(Stream.runIntoQueue(raw), Effect.forkScoped)

      const permissions = openCodePermissions(input.policy.permissionMode)
      const session = input.providerSessionId
        ? yield* client.session.get({ sessionID: input.providerSessionId as never }).pipe(Effect.mapError(protocolError("session.get")))
        : yield* client.session
            .create({
              title: "AgentDesk",
              location: Location.PublicRef.make({ directory: AbsolutePath.make(input.cwd) }) as never,
              permissions: permissions as never,
              ...(openCodeModel(input.policy.model, input.policy.effort) && { model: openCodeModel(input.policy.model, input.policy.effort) as never })
            })
            .pipe(Effect.mapError(protocolError("session.create")))
      const sessionID = session.id
      // A resumed session keeps the rules it was created with: apply the current permission mode.
      if (input.providerSessionId) {
        yield* client.session.update({ sessionID, permissions: permissions as never }).pipe(Effect.mapError(protocolError("session.update")))
      }
      if (input.policy.appendSystemPrompt) {
        yield* client.experimental.session.instructions.entry
          .put({ sessionID, key: INSTRUCTIONS_KEY as never, value: input.policy.appendSystemPrompt })
          .pipe(Effect.ignore)
      }

      // The model is a reference with the effort as its variant; switching either switches the model.
      const current = session.model as { id: string; providerID: string; variant?: string } | undefined
      let model = current ? `${current.providerID}/${current.id}` : input.policy.model
      let effort = current?.variant ?? input.policy.effort

      const normalizer = new OpenCodeNormalizer(sessionID)
      const events = yield* Queue.unbounded<AgentEvent, HarnessError | Cause.Done>()
      const emit = (e: AgentEvent) => Queue.offer(events, e).pipe(Effect.asVoid)
      yield* emit({ type: "session.started", providerSessionId: sessionID, cwd: input.cwd, ...(model && { model }) })

      yield* Stream.fromQueue(raw).pipe(
        Stream.runForEach((e) => Effect.forEach(normalizer.push(e), emit, { discard: true })),
        Effect.catch((e) => emit({ type: "session.error", message: e.message })),
        Effect.forkScoped
      )
      yield* server.exited.pipe(
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            const stderr = server.stderrTail().trim()
            if (exit.code && stderr) yield* emit({ type: "session.error", message: stderr.split("\n").slice(-5).join("\n") })
            yield* emit({ type: "session.exited", code: exit.code, signal: exit.signal })
          })
        ),
        Effect.ensuring(Queue.end(events)),
        Effect.forkScoped
      )
      yield* Effect.addFinalizer(() => Queue.end(events))

      const switchModel = (nextModel: string | undefined, nextEffort: string | undefined) =>
        Effect.gen(function* () {
          let ref = openCodeModel(nextModel, nextEffort)
          if (!ref && nextEffort) {
            // An effort for the default model: name that model explicitly.
            const fallback = yield* client.model.default({ location: { directory: input.cwd } }).pipe(Effect.mapError(protocolError("model.default")))
            ref = fallback.data ? { providerID: fallback.data.providerID, id: fallback.data.id, variant: nextEffort } : undefined
          }
          if (ref) yield* client.session.switchModel({ sessionID, model: ref as never }).pipe(Effect.mapError(protocolError("session.switchModel")))
        })

      const prompt = (text: string, images: ReadonlyArray<PromptImage> = [], opts?: PromptOptions) =>
        Effect.gen(function* () {
          const nextModel = opts?.model ?? model
          const nextEffort = opts?.model && !opts.effort ? undefined : (opts?.effort ?? effort)
          if (nextModel !== model || nextEffort !== effort) {
            yield* switchModel(nextModel, nextEffort)
            model = nextModel
            effort = nextEffort
          }
          yield* client.session
            .prompt({
              sessionID,
              text,
              ...(images.length > 0 && { files: images.map((i) => ({ uri: pathToFileURL(i.path).href, name: i.path.split("/").at(-1) })) })
            })
            .pipe(Effect.mapError(protocolError("session.prompt")))
        })

      const respondToApproval = (requestId: string, response: ApprovalResponse) => {
        const request = normalizer.pending.get(requestId)
        const target = (request?.sessionID ?? sessionID) as never
        if (request?.kind === "form") {
          normalizer.pending.delete(requestId)
          return (
            response.decision === "allow"
              ? client.session.form.reply({ sessionID: target, formID: requestId as never, answer: formAnswer(request.form, response.answers) as never })
              : client.session.form.cancel({ sessionID: target, formID: requestId as never } as never)
          ).pipe(Effect.mapError(protocolError("form reply")), Effect.asVoid)
        }
        const decision = response.decision === "deny" ? "reject" : response.scope === "session" ? "always" : "once"
        return client.permission
          .reply({ sessionID: target, requestID: requestId as never, decision, ...(decision === "reject" && response.note && { message: response.note }) })
          .pipe(Effect.mapError(protocolError("permission.reply")), Effect.asVoid)
      }

      if (input.prompt) yield* prompt(input.prompt, input.images)

      return {
        harness: "opencode",
        pid: server.pid,
        providerSessionId: Effect.succeed(sessionID),
        events: Stream.fromQueue(events),
        prompt,
        respondToApproval,
        interrupt: client.session.interrupt({ sessionID }).pipe(Effect.mapError(protocolError("session.interrupt")), Effect.asVoid)
      } satisfies HarnessSession
    })

  /** Models (with their effort variants) from a short-lived server; the plain model list if that fails. */
  const listModels = (binary: string): Effect.Effect<Array<HarnessModel>, never, ChildProcessSpawner.ChildProcessSpawner> =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startServer(binary, { cwd: tmpdir() }, 15_000)
        const res = yield* server.client.model.list({ location: { directory: tmpdir() } }).pipe(Effect.mapError(protocolError("model.list")))
        return parseModels(res.data)
      })
    ).pipe(
      Effect.timeout("20 seconds"),
      Effect.catch(() =>
        runCommand(binary, ["models"], { timeoutMs: 30_000 }).pipe(Effect.map((r) => (r.code === 0 ? parseModelLines(r.stdout) : [])))
      )
    )

  return {
    id: "opencode",
    displayName: "OpenCode",
    capabilities: OPENCODE_CAPABILITIES,
    detect: Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) return { id: "opencode" as const, installed: false, detail: "opencode CLI not found on PATH" }
      const r = yield* runCommand(binary, ["--version"], { timeoutMs: 15_000 })
      const models = r.code === 0 ? yield* listModels(binary) : []
      return {
        models,
        id: "opencode" as const,
        installed: r.code === 0,
        binary,
        version: r.stdout.trim().split(/\s+/).at(-1),
        detail: r.code === 0 ? "Runs a private `opencode serve` per session on 127.0.0.1." : r.stderr.trim(),
        capabilities: OPENCODE_CAPABILITIES
      }
    }),
    start: (input) => launch(input),
    resume: (input) => launch(input)
  }
}
