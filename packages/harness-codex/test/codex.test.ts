import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { type HarnessSession, NodeProcessLayer, parseJsonLine } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { describe, expect, it, layer } from "@effect/vitest"
import { CodexNormalizer, makeCodexAdapter } from "../src"

describe("CodexNormalizer", () => {
  it("normalizes a golden app-server transcript", () => {
    const n = new CodexNormalizer()
    const events = readFileSync(join(__dirname, "fixtures/turn.jsonl"), "utf8")
      .split("\n")
      .flatMap((l) => {
        const m = parseJsonLine(l)
        return m === undefined ? [] : n.push(m)
      })
    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "tool.started",
      "approval.requested",
      "tool.completed",
      "tool.started",
      "approval.requested",
      "tool.completed",
      "reasoning",
      "session.error",
      "turn.completed"
    ])
    expect(events[5]).toMatchObject({ providerRequestId: "0", toolName: "Bash", summary: "Bash: pnpm test" })
    expect(events[6]).toMatchObject({ isError: true, result: "1 failed" })
    expect(events[8]).toMatchObject({ providerRequestId: "5", summary: "Edit: src/a.ts" })
    expect(events.at(-1)).toMatchObject({ status: "success", providerSessionId: "thr_1", durationMs: 4200 })
    expect(n.activeTurnId).toBeUndefined()
  })
})

layer(NodeProcessLayer, { excludeTestServices: true })("Codex adapter (fake app-server)", (it) => {
  const adapter = makeCodexAdapter({ binary: join(__dirname, "fake-codex.mjs"), requestTimeoutMs: 5000 })

  const collect = (prompt: string, onEvent: (e: AgentEvent, s: HarnessSession) => Effect.Effect<void, unknown>, turns: number) =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" }, prompt })
      const seen: Array<AgentEvent> = []
      let done = 0
      yield* session.events.pipe(
        Stream.tap((e) => {
          seen.push(e)
          if (e.type === "turn.completed") done++
          return onEvent(e, session)
        }),
        Stream.takeUntil(() => done >= turns),
        Stream.runDrain
      )
      return { seen, threadId: yield* session.providerSessionId }
    })

  it.effect("round-trips approvals and queues follow-ups through the scoped turn loop", () =>
    Effect.gen(function* () {
      let sentFollowUp = false
      const { seen, threadId } = yield* collect(
        "run cmd",
        (e, s) =>
          Effect.gen(function* () {
            if (e.type === "approval.requested") yield* s.respondToApproval(e.providerRequestId!, "allow")
            if (e.type === "tool.started" && !sentFollowUp) {
              sentFollowUp = true
              yield* s.prompt("follow up") // queued until the first turn completes
            }
          }),
        2
      )
      expect(threadId).toBe("thr_fake")
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ isError: false, result: "file" })
      expect(seen.filter((e) => e.type === "message.completed").map((e) => (e as { text: string }).text)).toEqual([
        "echo run cmd",
        "echo follow up"
      ])
    })
  )

  it.effect("interrupts the active turn", () =>
    Effect.gen(function* () {
      const { seen } = yield* collect("hang", (e, s) => (e.type === "message.completed" ? s.interrupt : Effect.void), 1)
      expect(seen.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" })
    })
  )
})
