import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AgentEvent, HarnessCapabilities } from "@agentdesk/contracts"
import { type Cause, Deferred, Effect, FiberHandle, Queue, Ref, Stream } from "effect"
import { HarnessError } from "./errors"
import type { ApprovalResponse, HarnessAdapter, HarnessSession, PromptImage, StartInput } from "./types"

export interface MockOptions {
  /** Delay between streamed chunks. */
  readonly delayMs?: number
  /** Simulate a harness that only takes effort at launch (like Claude's `--effort`). */
  readonly effortAtLaunchOnly?: boolean
}

/**
 * Deterministic, process-free harness used for tests, demos and E2E flows.
 * Behaviour can be steered via markers in the prompt:
 *  - `[fail]`   — the turn ends with an error
 *  - `[noop]`   — no file changes
 *  - `[slow]`   — 10x slower streaming
 *  - `[write:path]` — write to a specific file (default: AGENTDESK_NOTES.md)
 *  - `[ask]`    — ask the user a question first and echo the answer
 *  - `[plan]`   — keep a three-step plan, updated as the turn progresses
 * Every turn reports token usage and a cost; the first turn also reports rate limits.
 * "Allow for this session" on a write approval skips approvals for later writes.
 */
export const MOCK_CAPABILITIES: HarnessCapabilities = {
  planMode: "native",
  acceptEdits: "native",
  liveEffort: true,
  allowForSession: true,
  questions: true,
  cost: true,
  rateLimits: true
}

export const makeMockAdapter = (options: MockOptions = {}): HarnessAdapter => {
  const start = (input: StartInput & { providerSessionId?: string }) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<AgentEvent, HarnessError | Cause.Done>()
      const providerSessionId = input.providerSessionId ?? `mock-${randomUUID()}`
      const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalResponse>>()
      let writesAllowed = false
      const ask = (event: Extract<AgentEvent, { type: "approval.requested" }>) =>
        Effect.gen(function* () {
          const d = yield* Deferred.make<ApprovalResponse>()
          pendingApprovals.set(event.approvalId, d)
          yield* emit(event)
          const response = yield* Deferred.await(d)
          pendingApprovals.delete(event.approvalId)
          return response
        })
      const turnCounter = yield* Ref.make(0)
      // The in-flight turn; interrupting the session interrupts this fiber.
      const turnFiber = yield* FiberHandle.make<void, HarnessError>()
      const emit = (e: AgentEvent) => Queue.offer(events, e)

      yield* Effect.addFinalizer(() => Queue.end(events))
      // The reported model reflects the launch policy (`model@effort`), so tests can see what a process got.
      const launched = `${input.policy.model ?? "mock-1"}${input.policy.effort ? `@${input.policy.effort}` : ""}`
      yield* emit({ type: "session.started", providerSessionId, model: launched, cwd: input.cwd })

      const runTurn = (text: string, images: ReadonlyArray<PromptImage> = []) =>
        Effect.gen(function* () {
          const turn = yield* Ref.updateAndGet(turnCounter, (n) => n + 1)
          const base = options.delayMs ?? 15
          const delay = text.includes("[slow]") ? base * 10 : base
          const messageId = `m${turn}`
          const planned = text.includes("[plan]")
          const plan = (done: number) =>
            emit({
              type: "plan.updated",
              items: ["Read the code", "Make the change", "Run the tests"].map((step, i) => ({
                text: step,
                status: i < done ? ("completed" as const) : i === done ? ("in_progress" as const) : ("pending" as const)
              }))
            })
          if (turn === 1) {
            yield* emit({
              type: "rate_limit",
              windows: [{ id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: new Date(Date.UTC(2030, 0, 1)).toISOString() }],
              limited: false
            })
          }
          if (planned) yield* plan(0)
          let answer: string | undefined
          if (text.includes("[ask]")) {
            const questionId = randomUUID()
            const response = yield* ask({
              type: "approval.requested",
              approvalId: questionId,
              providerRequestId: questionId,
              toolName: "AskUserQuestion",
              kind: "question",
              summary: "Which database should I use?",
              questions: [
                {
                  id: "db",
                  header: "Database",
                  question: "Which database should I use?",
                  options: [{ label: "SQLite", description: "Embedded, zero setup" }, { label: "Postgres" }],
                  multiSelect: false,
                  allowOther: true
                }
              ]
            })
            answer = response.decision === "allow" ? (response.answers?.db ?? []).join(", ") || "(no answer)" : "(declined)"
          }
          const reply = text.includes("[fail]")
            ? "I could not complete this task."
            : `${answer !== undefined ? `You answered: ${answer}. ` : ""}Working on it. Turn ${turn}: I analysed the request "${text.slice(0, 80)}" and will make a focused change.`
          let acc = ""
          for (const word of reply.split(/(?<= )/)) {
            acc += word
            yield* emit({ type: "message.delta", messageId, text: word })
            yield* Effect.sleep(delay)
          }
          yield* emit({ type: "message.completed", messageId, text: acc })
          if (images.length > 0) {
            const toolCallId = `screenshot-${turn}`
            yield* emit({ type: "tool.started", toolCallId, name: "Screenshot", input: { images: images.length } })
            yield* emit({ type: "tool.completed", toolCallId, result: `Received ${images.length} image(s)` })
            yield* emit({ type: "image", toolCallId, source: { data: images[0]!.data, mimeType: images[0]!.mimeType } })
          }
          if (text.includes("[fail]")) {
            yield* emit({ type: "session.error", message: "Mock failure requested", recoverable: true })
            yield* emit({ type: "turn.completed", providerSessionId, status: "error" })
            return
          }
          if (planned) yield* plan(1)
          if (!text.includes("[noop]")) {
            const target = /\[write:([^\]]+)\]/.exec(text)?.[1] ?? "AGENTDESK_NOTES.md"
            const toolCallId = `tool-${turn}`
            const toolInput = { file_path: target, content: `# Turn ${turn}\n\n${text}\n` }
            yield* emit({ type: "tool.started", toolCallId, name: "Write", input: toolInput })
            let allowed = true
            if (input.policy.permissionMode === "ask" && !writesAllowed) {
              const requestId = randomUUID()
              const response = yield* ask({
                type: "approval.requested",
                approvalId: requestId,
                providerRequestId: requestId,
                toolName: "Write",
                summary: `Write: ${target}`,
                details: toolInput,
                canAllowForSession: true
              })
              allowed = response.decision === "allow"
              if (allowed && response.scope === "session") writesAllowed = true
            }
            if (allowed) {
              const full = join(input.cwd, target)
              yield* Effect.try({
                try: () => {
                  mkdirSync(dirname(full), { recursive: true })
                  writeFileSync(full, toolInput.content, { flag: "a" })
                },
                catch: (cause) => new HarnessError({ harness: "mock", reason: "io", message: String(cause), cause })
              }).pipe(Effect.catch((e) => emit({ type: "session.error", message: e.message })))
              yield* emit({ type: "tool.completed", toolCallId, result: `Wrote ${target}` })
            } else {
              yield* emit({ type: "tool.completed", toolCallId, result: "Permission denied by user", isError: true })
            }
          }
          if (planned) yield* plan(3)
          const summary = `Done with turn ${turn}.`
          yield* emit({ type: "message.completed", messageId: `${messageId}-final`, text: summary })
          yield* emit({
            type: "turn.completed",
            providerSessionId,
            status: "success",
            costUsd: 0.01,
            durationMs: 1,
            summary,
            usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 },
            model: launched
          })
        })

      // The daemon records `user.prompt` itself, uniformly for every harness.
      const prompt = (text: string, images?: ReadonlyArray<PromptImage>) =>
        FiberHandle.run(
          turnFiber,
          runTurn(text, images).pipe(
            Effect.onInterrupt(() => emit({ type: "turn.completed", providerSessionId, status: "interrupted" })),
            Effect.withSpan("mock.turn")
          ),
          { onlyIfMissing: true }
        ).pipe(Effect.asVoid)

      if (input.prompt) yield* prompt(input.prompt, input.images)

      return {
        harness: "mock",
        pid: undefined,
        providerSessionId: Effect.succeed(providerSessionId),
        events: Stream.fromQueue(events),
        prompt,
        respondToApproval: (requestId, response) =>
          Effect.gen(function* () {
            const d = pendingApprovals.get(requestId)
            if (!d) {
              return yield* new HarnessError({ harness: "mock", reason: "protocol", message: `Unknown approval ${requestId}` })
            }
            yield* Deferred.succeed(d, response)
          }),
        interrupt: FiberHandle.clear(turnFiber),
        ...(options.effortAtLaunchOnly && { liveEffort: false })
      } satisfies HarnessSession
    })

  return {
    id: "mock",
    displayName: "Mock (demo)",
    capabilities: MOCK_CAPABILITIES,
    detect: Effect.succeed({ id: "mock", installed: true, authenticated: true, version: "1.0.0", detail: "Built-in simulated agent" }),
    start: (input) => start(input),
    resume: (input) => start(input)
  }
}
