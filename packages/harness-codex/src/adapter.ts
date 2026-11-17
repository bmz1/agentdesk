import type { ApprovalDecision, PermissionMode } from "@agentdesk/contracts"
import {
  eventsStream,
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  isRecord,
  runCommand,
  spawnManaged,
  type StartInput,
  str,
  wireLineProcess
} from "@agentdesk/harness-core"
import { Deferred, Effect } from "effect"
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
            // Server→client request we cannot service: reject so the agent doesn't hang.
            const method = str(msg.method)
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
        ? yield* request("thread/resume", { threadId: input.providerSessionId, cwd: input.cwd, ...policy })
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

      // Codex accepts one turn at a time; follow-ups sent mid-turn are queued until it completes.
      const queue: Array<string> = []
      const startTurn = (text: string) =>
        request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] }).pipe(
          Effect.tap((r) =>
            Effect.sync(() => {
              const turn = isRecord(r) && isRecord(r.turn) ? r.turn : undefined
              normalizer.activeTurnId = str(turn?.id) ?? normalizer.activeTurnId ?? "pending"
            })
          ),
          Effect.asVoid
        )
      const prompt = (text: string) =>
        normalizer.activeTurnId ? Effect.sync(() => void queue.push(text)) : startTurn(text)

      // Drain the queue whenever a turn completes.
      const originalPush = normalizer.push.bind(normalizer)
      normalizer.push = (m) => {
        const out = originalPush(m)
        if (out.some((e) => e.type === "turn.completed") && queue.length > 0) {
          const next = queue.shift()!
          Effect.runFork(startTurn(next).pipe(Effect.ignore))
        }
        return out
      }

      if (input.prompt) yield* startTurn(input.prompt)

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
        interrupt: Effect.suspend(() => {
          queue.length = 0
          const turnId = normalizer.activeTurnId
          return turnId && turnId !== "pending" ? request("turn/interrupt", { threadId, turnId }).pipe(Effect.asVoid) : Effect.void
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
      return {
        id: "codex" as const,
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
