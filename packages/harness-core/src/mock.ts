import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AgentEvent, ApprovalDecision } from "@agentdesk/contracts"
import { type Cause, Deferred, Effect, FiberHandle, Queue, Ref, Stream } from "effect"
import { HarnessError } from "./errors"
import type { HarnessAdapter, HarnessSession, StartInput } from "./types"

export interface MockOptions {
  /** Delay between streamed chunks. */
  readonly delayMs?: number
}

/**
 * Deterministic, process-free harness used for tests, demos and E2E flows.
 * Behaviour can be steered via markers in the prompt:
 *  - `[fail]`   — the turn ends with an error
 *  - `[noop]`   — no file changes
 *  - `[slow]`   — 10x slower streaming
 *  - `[write:path]` — write to a specific file (default: AGENTDESK_NOTES.md)
 */
export const makeMockAdapter = (options: MockOptions = {}): HarnessAdapter => {
  const start = (input: StartInput & { providerSessionId?: string }) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<AgentEvent, HarnessError | Cause.Done>()
      const providerSessionId = input.providerSessionId ?? `mock-${randomUUID()}`
      const pendingApprovals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
      const turnCounter = yield* Ref.make(0)
      // The in-flight turn; interrupting the session interrupts this fiber.
      const turnFiber = yield* FiberHandle.make<void, HarnessError>()
      const emit = (e: AgentEvent) => Queue.offer(events, e)

      yield* Effect.addFinalizer(() => Queue.end(events))
      yield* emit({ type: "session.started", providerSessionId, model: "mock-1", cwd: input.cwd })

      const runTurn = (text: string) =>
        Effect.gen(function* () {
          const turn = yield* Ref.updateAndGet(turnCounter, (n) => n + 1)
          const base = options.delayMs ?? 15
          const delay = text.includes("[slow]") ? base * 10 : base
          const messageId = `m${turn}`
          const reply = text.includes("[fail]")
            ? "I could not complete this task."
            : `Working on it. Turn ${turn}: I analysed the request "${text.slice(0, 80)}" and will make a focused change.`
          let acc = ""
          for (const word of reply.split(/(?<= )/)) {
            acc += word
            yield* emit({ type: "message.delta", messageId, text: word })
            yield* Effect.sleep(delay)
          }
          yield* emit({ type: "message.completed", messageId, text: acc })
          if (text.includes("[fail]")) {
            yield* emit({ type: "session.error", message: "Mock failure requested", recoverable: true })
            yield* emit({ type: "turn.completed", providerSessionId, status: "error" })
            return
          }
          if (!text.includes("[noop]")) {
            const target = /\[write:([^\]]+)\]/.exec(text)?.[1] ?? "AGENTDESK_NOTES.md"
            const toolCallId = `tool-${turn}`
            const toolInput = { file_path: target, content: `# Turn ${turn}\n\n${text}\n` }
            yield* emit({ type: "tool.started", toolCallId, name: "Write", input: toolInput })
            let allowed = true
            if (input.policy.permissionMode === "ask") {
              const requestId = randomUUID()
              const d = yield* Deferred.make<ApprovalDecision>()
              pendingApprovals.set(requestId, d)
              yield* emit({
                type: "approval.requested",
                approvalId: requestId,
                providerRequestId: requestId,
                toolName: "Write",
                summary: `Write: ${target}`,
                details: toolInput
              })
              allowed = (yield* Deferred.await(d)) === "allow"
              pendingApprovals.delete(requestId)
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
          const summary = `Done with turn ${turn}.`
          yield* emit({ type: "message.completed", messageId: `${messageId}-final`, text: summary })
          yield* emit({ type: "turn.completed", providerSessionId, status: "success", costUsd: 0, durationMs: 1, summary })
        })

      // The daemon records `user.prompt` itself, uniformly for every harness.
      const prompt = (text: string) =>
        FiberHandle.run(
          turnFiber,
          runTurn(text).pipe(
            Effect.onInterrupt(() => emit({ type: "turn.completed", providerSessionId, status: "interrupted" })),
            Effect.withSpan("mock.turn")
          ),
          { onlyIfMissing: true }
        ).pipe(Effect.asVoid)

      if (input.prompt) yield* prompt(input.prompt)

      return {
        harness: "mock",
        pid: undefined,
        providerSessionId: Effect.succeed(providerSessionId),
        events: Stream.fromQueue(events),
        prompt,
        respondToApproval: (requestId, decision) =>
          Effect.gen(function* () {
            const d = pendingApprovals.get(requestId)
            if (!d) {
              return yield* new HarnessError({ harness: "mock", reason: "protocol", message: `Unknown approval ${requestId}` })
            }
            yield* Deferred.succeed(d, decision)
          }),
        interrupt: FiberHandle.clear(turnFiber)
      } satisfies HarnessSession
    })

  return {
    id: "mock",
    displayName: "Mock (demo)",
    detect: Effect.succeed({ id: "mock", installed: true, authenticated: true, version: "1.0.0", detail: "Built-in simulated agent" }),
    start: (input) => start(input),
    resume: (input) => start(input)
  }
}
