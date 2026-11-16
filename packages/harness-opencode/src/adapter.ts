import type { AgentEvent, ApprovalDecision, PermissionMode } from "@agentdesk/contracts"
import {
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  isRecord,
  runCommand,
  spawnManaged,
  type StartInput,
  str
} from "@agentdesk/harness-core"
import { Cause, Deferred, Effect, Queue, Stream } from "effect"
import { OpenCodeNormalizer } from "./normalizer"

export interface OpenCodeAdapterOptions {
  readonly binary?: string
  readonly startupTimeoutMs?: number
}

/** OpenCode permission rules derived from the project's policy. */
export const openCodePermissions = (mode: PermissionMode) => {
  const rule = (permission: string, action: "allow" | "ask" | "deny") => ({ permission, pattern: "*", action })
  switch (mode) {
    case "ask":
      return [rule("edit", "ask"), rule("bash", "ask"), rule("webfetch", "ask")]
    case "accept_edits":
      return [rule("edit", "allow"), rule("bash", "ask"), rule("webfetch", "ask")]
    case "plan":
      return [rule("edit", "deny"), rule("bash", "ask"), rule("webfetch", "ask")]
    case "unrestricted":
      return [rule("*", "allow")]
  }
}

const LISTENING = /listening on (https?:\/\/[^\s]+)/

/** Parse an SSE byte stream into JSON `data:` payloads. */
export const sseJson = (body: ReadableStream<Uint8Array>): Stream.Stream<unknown, HarnessError> =>
  Stream.fromReadableStream({
    evaluate: () => body,
    onError: (e) => new HarnessError({ harness: "opencode", reason: "io", message: `Event stream failed: ${String(e)}` })
  }).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((l) => l.startsWith("data:")),
    Stream.map((l) => {
      try {
        return JSON.parse(l.slice(5).trim()) as unknown
      } catch {
        return undefined
      }
    }),
    Stream.filter((u) => u !== undefined)
  )

export const makeOpenCodeAdapter = (options: OpenCodeAdapterOptions = {}): HarnessAdapter => {
  const resolveBinary = () => options.binary ?? process.env.AGENTDESK_OPENCODE_BIN ?? findExecutable("opencode")

  const launch = (input: StartInput & { providerSessionId?: string }) =>
    Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) {
        return yield* new HarnessError({ harness: "opencode", reason: "not_installed", message: "opencode CLI not found on PATH" })
      }
      // One server per session, bound to loopback, rooted at the worktree.
      const proc = yield* spawnManaged({
        harness: "opencode",
        command: binary,
        args: ["serve", "--port", "0", "--hostname", "127.0.0.1"],
        cwd: input.cwd,
        env: input.policy.env
      })
      const urlReady = yield* Deferred.make<string, HarnessError>()
      yield* proc.lines.pipe(
        Stream.runForEach((line) => {
          const m = LISTENING.exec(line)
          return m ? Deferred.succeed(urlReady, m[1]!.replace(/\/$/, "")) : Effect.void
        }),
        Effect.andThen(
          Deferred.fail(urlReady, new HarnessError({ harness: "opencode", reason: "spawn_failed", message: proc.stderrTail().trim() || "opencode serve exited" }))
        ),
        Effect.forkScoped
      )
      const base = yield* Deferred.await(urlReady).pipe(
        Effect.timeoutOrElse({
          duration: options.startupTimeoutMs ?? 30_000,
          orElse: () => Effect.fail(new HarnessError({ harness: "opencode", reason: "timeout", message: "opencode serve did not start" }))
        })
      )
      const dir = `directory=${encodeURIComponent(input.cwd)}`

      const http = (method: string, path: string, body?: unknown) =>
        Effect.tryPromise({
          try: async (signal) => {
            const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}${dir}`, {
              method,
              signal,
              headers: body === undefined ? {} : { "content-type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            if (!res.ok) throw Object.assign(new Error(`${res.status} ${text.slice(0, 200)}`), { status: res.status })
            return text ? (JSON.parse(text) as unknown) : undefined
          },
          catch: (e) => new HarnessError({ harness: "opencode", reason: "protocol", message: `opencode ${method} ${path}: ${(e as Error).message}`, cause: e })
        })

      // Subscribe to the event bus *before* creating/prompting the session so nothing is missed.
      const eventRes = yield* Effect.tryPromise({
        try: (signal) => fetch(`${base}/event?${dir}`, { signal, headers: { accept: "text/event-stream" } }),
        catch: (e) => new HarnessError({ harness: "opencode", reason: "io", message: `opencode /event: ${String(e)}` })
      })
      if (!eventRes.ok || !eventRes.body) {
        return yield* new HarnessError({ harness: "opencode", reason: "protocol", message: `opencode /event returned ${eventRes.status}` })
      }

      const session = input.providerSessionId
        ? yield* http("GET", `/session/${encodeURIComponent(input.providerSessionId)}`)
        : yield* http("POST", "/session", { title: "AgentDesk", permission: openCodePermissions(input.policy.permissionMode) })
      const sessionId = isRecord(session) ? str(session.id) : undefined
      if (!sessionId) return yield* new HarnessError({ harness: "opencode", reason: "protocol", message: "opencode returned no session id" })

      const normalizer = new OpenCodeNormalizer(sessionId)
      const events = yield* Queue.unbounded<AgentEvent, HarnessError | Cause.Done>()
      const emit = (e: AgentEvent) => Queue.offer(events, e).pipe(Effect.asVoid)
      yield* emit({ type: "session.started", providerSessionId: sessionId, cwd: input.cwd })

      yield* sseJson(eventRes.body).pipe(
        Stream.runForEach((m) => Effect.forEach(normalizer.push(m), emit, { discard: true })),
        Effect.catch((e) => emit({ type: "session.error", message: e.message })),
        Effect.forkScoped
      )
      yield* proc.exited.pipe(
        Effect.flatMap((exit) => emit({ type: "session.exited", code: exit.code, signal: exit.signal })),
        Effect.ensuring(Queue.end(events)),
        Effect.forkScoped
      )
      yield* Effect.addFinalizer(() => Queue.end(events))

      const prompt = (text: string) =>
        Effect.sync(() => normalizer.markBusy()).pipe(
          Effect.andThen(
            http("POST", `/session/${sessionId}/prompt_async`, {
              parts: [{ type: "text", text }],
              ...(input.policy.appendSystemPrompt && { system: input.policy.appendSystemPrompt })
            })
          ),
          Effect.asVoid
        )

      const respondToApproval = (requestId: string, decision: ApprovalDecision) => {
        const reply = decision === "allow" ? "once" : "reject"
        return http("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply }).pipe(
          // Older servers only expose the session-scoped endpoint.
          Effect.catch(() =>
            http("POST", `/session/${sessionId}/permissions/${encodeURIComponent(requestId)}`, { response: reply })
          ),
          Effect.asVoid
        )
      }

      if (input.prompt) yield* prompt(input.prompt)

      return {
        harness: "opencode",
        pid: proc.pid,
        providerSessionId: Effect.succeed(sessionId),
        events: Stream.fromQueue(events),
        prompt,
        respondToApproval,
        interrupt: http("POST", `/session/${sessionId}/abort`).pipe(Effect.asVoid)
      } satisfies HarnessSession
    })

  return {
    id: "opencode",
    displayName: "OpenCode",
    detect: Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) return { id: "opencode" as const, installed: false, detail: "opencode CLI not found on PATH" }
      const r = yield* runCommand(binary, ["--version"], { timeoutMs: 15_000 })
      return {
        id: "opencode" as const,
        installed: r.code === 0,
        binary,
        version: r.stdout.trim().split(/\s+/).at(-1),
        detail: r.code === 0 ? "Runs `opencode serve` per session on 127.0.0.1." : r.stderr.trim()
      }
    }),
    start: (input) => launch(input),
    resume: (input) => launch(input)
  }
}
