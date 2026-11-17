import type { ApprovalDecision, PermissionMode } from "@agentdesk/contracts"
import {
  eventsStream,
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  type PromptImage,
  isRecord,
  runCommand,
  spawnManaged,
  type StartInput,
  str,
  wireLineProcess
} from "@agentdesk/harness-core"
import { Deferred, Duration, Effect, Queue, Stream } from "effect"
import { APPROVAL_METHODS, CodexNormalizer } from "./normalizer"

export interface CodexAdapterOptions {
  readonly binary?: string
  readonly requestTimeoutMs?: number
}

export const codexPolicy = (mode: PermissionMode) => {
  switch (mode) {
    case "ask":
    case "accept_edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" } as const
    case "plan":
      return { approvalPolicy: "on-request", sandbox: "read-only" } as const
    case "unrestricted":
      return { approvalPolicy: "never", sandbox: "danger-full-access" } as const
  }
}

/** Models offered by `codex app-server` (`model/list`); empty when unavailable. */
export const listCodexModels = (binary: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* spawnManaged({ harness: "codex", command: binary, args: ["app-server"], cwd: process.cwd() })
      // The server only answers while stdin stays open, so write without closing it.
      yield* proc.write(
        [
          { id: 1, method: "initialize", params: { clientInfo: { name: "agentdesk", title: "AgentDesk", version: "0.1.0" } } },
          { method: "initialized" },
          { id: 2, method: "model/list", params: {} }
        ]
          .map((m) => JSON.stringify(m) + "\n")
          .join("")
      )
      const reply = yield* proc.lines.pipe(
        Stream.map((l) => {
          try {
            return JSON.parse(l) as unknown
          } catch {
            return undefined
          }
        }),
        Stream.filter((m) => isRecord(m) && m.id === 2),
        Stream.runHead
      )
      const result = reply._tag === "Some" && isRecord(reply.value) && isRecord(reply.value.result) ? reply.value.result : {}
      const data = Array.isArray(result.data) ? result.data : []
      return data.flatMap((m) => {
        const id = isRecord(m) && m.hidden !== true ? str(m.id) : undefined
        return id ? [{ id, label: str((m as Record<string, unknown>).displayName) ?? id }] : []
      })
    })
  ).pipe(
    Effect.timeoutOrElse({ duration: Duration.seconds(15), orElse: () => Effect.succeed([]) }),
    Effect.orElseSucceed(() => [])
  )

export const makeCodexAdapter = (options: CodexAdapterOptions = {}): HarnessAdapter => {
  const resolveBinary = () => options.binary ?? process.env.AGENTDESK_CODEX_BIN ?? findExecutable("codex")

  const launch = (input: StartInput & { providerSessionId?: string }) =>
    Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) {
        return yield* new HarnessError({ harness: "codex", reason: "not_installed", message: "codex CLI not found on PATH" })
      }
      const proc = yield* spawnManaged({
        harness: "codex",
        command: binary,
        args: ["app-server"],
        cwd: input.cwd,
        env: input.policy.env,
        sandboxPrefix: input.policy.sandboxPrefix
      })
      const normalizer = new CodexNormalizer()
      const pending = new Map<string, Deferred.Deferred<unknown, HarnessError>>()
      const approvalKinds = new Map<string, { legacy: boolean; rawId: unknown }>()
      let nextId = 1
      // Completion signal of the turn currently in flight (replaced per turn).
      let turnDone = yield* Deferred.make<void>()
      const send = (msg: Record<string, unknown>) => proc.write(JSON.stringify(msg) + "\n")

      const request = (method: string, params: unknown) =>
        Effect.gen(function* () {
          const id = String(nextId++)
          const d = yield* Deferred.make<unknown, HarnessError>()
          pending.set(id, d)
          yield* send({ id: Number(id), method, params })
          return yield* Deferred.await(d).pipe(
            Effect.timeoutOrElse({
              duration: options.requestTimeoutMs ?? 60_000,
              orElse: () =>
                Effect.fail(new HarnessError({ harness: "codex", reason: "timeout", message: `codex ${method} timed out` }))
            }),
            Effect.ensuring(Effect.sync(() => pending.delete(id)))
          )
        })

      const { emit, events } = yield* wireLineProcess({
        harness: "codex",
        process: proc,
        normalizer,
        onMessage: (msg) =>
          Effect.gen(function* () {
            if (!isRecord(msg)) return false
            // Response to one of our requests.
            if (msg.id !== undefined && msg.method === undefined) {
              const d = pending.get(String(msg.id))
              if (d) {
                if (isRecord(msg.error)) {
                  yield* Deferred.fail(
                    d,
                    new HarnessError({ harness: "codex", reason: "protocol", message: str(msg.error.message) ?? "codex error" })
                  )
                } else yield* Deferred.succeed(d, msg.result)
              }
              return true
            }
            const method = str(msg.method)
            if (method === "turn/completed") yield* Deferred.succeed(turnDone, undefined)
            // Server→client request we cannot service: reject so the agent doesn't hang.
            if (msg.id !== undefined && method) {
              const spec = APPROVAL_METHODS[method]
              if (spec) {
                approvalKinds.set(String(msg.id), { legacy: spec.legacy, rawId: msg.id })
                return false
              }
              yield* send({ id: msg.id, error: { code: -32601, message: `AgentDesk does not support ${method}` } }).pipe(Effect.ignore)
              return true
            }
            return false
          })
      })

      const policy = codexPolicy(input.policy.permissionMode)
      yield* request("initialize", { clientInfo: { name: "agentdesk", title: "AgentDesk", version: "0.1.0" } })
      yield* send({ method: "initialized" })
      const threadResult = input.providerSessionId
        ? yield* request("thread/resume", {
            threadId: input.providerSessionId,
            cwd: input.cwd,
            ...policy,
            ...(input.policy.model && { model: input.policy.model })
          })
        : yield* request("thread/start", {
            cwd: input.cwd,
            ...policy,
            ...(input.policy.model && { model: input.policy.model }),
            ...(input.policy.appendSystemPrompt && { developerInstructions: input.policy.appendSystemPrompt })
          })
      const thread = isRecord(threadResult) && isRecord(threadResult.thread) ? threadResult.thread : {}
      const threadId = str(thread.id)
      if (!threadId) return yield* new HarnessError({ harness: "codex", reason: "protocol", message: "codex returned no thread id" })
      normalizer.threadId = threadId
      if (input.providerSessionId) {
        yield* emit({ type: "session.started", providerSessionId: threadId, model: str(thread.model), cwd: input.cwd })
      }

      // Codex accepts one turn at a time. Prompts go through a queue drained by a
      // single scoped fiber that starts a turn and waits for its completion.
      const prompts = yield* Queue.unbounded<{ text: string; images: ReadonlyArray<PromptImage> }>()
      yield* Effect.gen(function* () {
        const { text, images } = yield* Queue.take(prompts)
        const done = yield* Deferred.make<void>()
        turnDone = done
        yield* startTurn(text, images).pipe(
          Effect.catch((e) => Effect.andThen(emit({ type: "session.error", message: e.message }), Deferred.succeed(done, undefined)))
        )
        yield* Deferred.await(done)
      }).pipe(Effect.forever, Effect.forkScoped)

      const startTurn = (text: string, images: ReadonlyArray<PromptImage>) =>
        request("turn/start", {
          threadId,
          input: [{ type: "text", text, text_elements: [] }, ...images.map((i) => ({ type: "localImage", path: i.path }))]
        }).pipe(
          Effect.tap((r) =>
            Effect.sync(() => {
              const turn = isRecord(r) && isRecord(r.turn) ? r.turn : undefined
              normalizer.activeTurnId = str(turn?.id) ?? normalizer.activeTurnId ?? "pending"
            })
          ),
          Effect.asVoid,
          Effect.withSpan("codex.turn.start", { attributes: { threadId } })
        )
      const prompt = (text: string, images: ReadonlyArray<PromptImage> = []) => Queue.offer(prompts, { text, images }).pipe(Effect.asVoid)

      if (input.prompt) yield* prompt(input.prompt, input.images)

      const respondToApproval = (requestId: string, decision: ApprovalDecision) => {
        const kind = approvalKinds.get(requestId)
        approvalKinds.delete(requestId)
        const value = kind?.legacy ? (decision === "allow" ? "approved" : "denied") : decision === "allow" ? "accept" : "decline"
        return send({ id: kind?.rawId ?? Number(requestId), result: { decision: value } })
      }

      return {
        harness: "codex",
        pid: proc.pid,
        providerSessionId: Effect.sync(() => normalizer.threadId),
        events: eventsStream(events),
        prompt,
        respondToApproval,
        interrupt: Effect.gen(function* () {
          yield* Queue.clear(prompts)
          const turnId = normalizer.activeTurnId
          if (turnId && turnId !== "pending") yield* request("turn/interrupt", { threadId, turnId })
        })
      } satisfies HarnessSession
    })

  return {
    id: "codex",
    displayName: "Codex",
    detect: Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) return { id: "codex" as const, installed: false, detail: "codex CLI not found on PATH" }
      const r = yield* runCommand(binary, ["--version"], { timeoutMs: 10_000 })
      const models = r.code === 0 ? yield* listCodexModels(binary) : []
      return {
        id: "codex" as const,
        models,
        installed: r.code === 0,
        binary,
        version: r.stdout.trim().split(/\s+/).at(-1),
        detail: r.code === 0 ? "Uses `codex app-server` with the CLI's own login." : r.stderr.trim()
      }
    }),
    start: (input) => launch(input),
    resume: (input) => launch(input)
  }
}
