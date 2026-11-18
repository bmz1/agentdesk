import type { HarnessCapabilities, PermissionMode } from "@agentdesk/contracts"
import {
  type ApprovalResponse,
  eventsStream,
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  type PromptImage,
  type PromptOptions,
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

/**
 * AgentDesk's permission modes on Codex. "untrusted" asks before anything but known-safe
 * reads, like Claude's default mode. Codex has no "accept edits" policy, so AgentDesk
 * approves its edit requests itself (`autoApproveEdits`) and still asks for commands.
 * Codex's plan mode can't be set over the app-server API: "plan" is a read-only sandbox.
 */
export const codexPolicy = (mode: PermissionMode) => {
  switch (mode) {
    case "ask":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" } as const
    case "accept_edits":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" } as const
    // Escalations go to Codex's auto-review subagent instead of the user.
    case "auto":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" } as const
    case "plan":
      return { approvalPolicy: "on-request", sandbox: "read-only" } as const
    case "unrestricted":
      return { approvalPolicy: "never", sandbox: "danger-full-access" } as const
  }
}

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  planMode: "read_only",
  acceptEdits: "auto_approved",
  liveEffort: true,
  allowForSession: true,
  questions: true,
  cost: false,
  rateLimits: true
}

/** The JSON-RPC result answering an approval or question request. */
export const codexApprovalResult = (spec: { legacy: boolean; kind: "tool" | "question" } | undefined, r: ApprovalResponse) => {
  if (spec?.kind === "question") {
    const answers = r.decision === "allow" ? Object.fromEntries(Object.entries(r.answers ?? {}).map(([id, a]) => [id, { answers: [...a] }])) : {}
    return { answers }
  }
  const session = r.scope === "session"
  if (spec?.legacy) return { decision: r.decision === "deny" ? "denied" : session ? "approved_for_session" : "approved" }
  return { decision: r.decision === "deny" ? "decline" : session ? "acceptForSession" : "accept" }
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
        if (!id) return []
        const rec = m as Record<string, unknown>
        const efforts = (Array.isArray(rec.supportedReasoningEfforts) ? rec.supportedReasoningEfforts : []).flatMap((e) => {
          const level = isRecord(e) ? str(e.reasoningEffort) : str(e)
          return level ? [level] : []
        })
        const defaultEffort = str(rec.defaultReasoningEffort)
        return [{ id, label: str(rec.displayName) ?? id, ...(efforts.length && { efforts }), ...(defaultEffort && { defaultEffort }) }]
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
      const approvalKinds = new Map<string, { legacy: boolean; kind: "tool" | "question"; rawId: unknown }>()
      const autoApproveEdits = input.policy.permissionMode === "accept_edits"
      // An interrupt that arrives before `turn/start` returned a turn id is sent once the id is known.
      let interruptPending = false
      let turnInFlight = false
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
                if (spec.edit && autoApproveEdits) {
                  yield* send({ id: msg.id, result: codexApprovalResult(spec, { decision: "allow" }) }).pipe(Effect.ignore)
                  return true
                }
                approvalKinds.set(String(msg.id), { legacy: spec.legacy, kind: spec.kind, rawId: msg.id })
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
            ...(input.policy.model && { model: input.policy.model }),
            ...(input.policy.appendSystemPrompt && { developerInstructions: input.policy.appendSystemPrompt })
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
      // Current account limits; later changes arrive as `account/rateLimits/updated`.
      yield* request("account/rateLimits/read", {}).pipe(
        Effect.flatMap((r) => Effect.forEach(normalizer.rateLimits(isRecord(r) ? r.rateLimits : undefined), emit, { discard: true })),
        Effect.ignore
      )
      if (input.providerSessionId) {
        yield* emit({ type: "session.started", providerSessionId: threadId, model: str(thread.model), cwd: input.cwd })
      }

      // Codex accepts one turn at a time. Prompts go through a queue drained by a
      // single scoped fiber that starts a turn and waits for its completion.
      const prompts = yield* Queue.unbounded<{ text: string; images: ReadonlyArray<PromptImage>; model?: string; effort?: string }>()
      // Codex takes the effort per turn; remember the latest so every turn carries it.
      let effort = input.policy.effort
      yield* Effect.gen(function* () {
        const { text, images, model, effort: turnEffort } = yield* Queue.take(prompts)
        if (turnEffort) effort = turnEffort
        const done = yield* Deferred.make<void>()
        turnDone = done
        turnInFlight = true
        yield* startTurn(text, images, model).pipe(
          Effect.catch((e) => Effect.andThen(emit({ type: "session.error", message: e.message }), Deferred.succeed(done, undefined)))
        )
        yield* Deferred.await(done)
        turnInFlight = false
        interruptPending = false
      }).pipe(Effect.forever, Effect.forkScoped)

      const startTurn = (text: string, images: ReadonlyArray<PromptImage>, model?: string) =>
        request("turn/start", {
          threadId,
          // A per-turn override that also sticks for later turns of the thread.
          ...(model && { model }),
          ...(effort && { effort }),
          input: [{ type: "text", text, text_elements: [] }, ...images.map((i) => ({ type: "localImage", path: i.path }))]
        }).pipe(
          Effect.tap((r) =>
            Effect.gen(function* () {
              const turn = isRecord(r) && isRecord(r.turn) ? r.turn : undefined
              normalizer.activeTurnId = str(turn?.id) ?? normalizer.activeTurnId ?? "pending"
              if (interruptPending && normalizer.activeTurnId !== "pending") {
                interruptPending = false
                yield* request("turn/interrupt", { threadId, turnId: normalizer.activeTurnId }).pipe(Effect.ignore)
              }
            })
          ),
          Effect.asVoid,
          Effect.withSpan("codex.turn.start", { attributes: { threadId } })
        )
      const prompt = (text: string, images: ReadonlyArray<PromptImage> = [], options?: PromptOptions) =>
        Queue.offer(prompts, {
          text,
          images,
          ...(options?.model && { model: options.model }),
          ...(options?.effort && { effort: options.effort })
        }).pipe(Effect.asVoid)

      if (input.prompt) yield* prompt(input.prompt, input.images)

      const respondToApproval = (requestId: string, response: ApprovalResponse) => {
        const kind = approvalKinds.get(requestId)
        approvalKinds.delete(requestId)
        return send({ id: kind?.rawId ?? Number(requestId), result: codexApprovalResult(kind, response) })
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
          // The turn is starting but has no id yet: interrupt as soon as it does.
          else if (turnInFlight) interruptPending = true
        })
      } satisfies HarnessSession
    })

  return {
    id: "codex",
    displayName: "Codex",
    capabilities: CODEX_CAPABILITIES,
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
        detail: r.code === 0 ? "Uses `codex app-server` with the CLI's own login." : r.stderr.trim(),
        capabilities: CODEX_CAPABILITIES
      }
    }),
    start: (input) => launch(input),
    resume: (input) => launch(input)
  }
}
