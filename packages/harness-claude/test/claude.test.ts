import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { parseJsonLine } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ClaudeNormalizer, makeClaudeAdapter } from "../src"

describe("ClaudeNormalizer", () => {
  it("normalizes a golden stream-json transcript", () => {
    const n = new ClaudeNormalizer()
    const lines = readFileSync(join(__dirname, "fixtures/turn.jsonl"), "utf8").split("\n")
    const events = lines.flatMap((l) => {
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
      "reasoning",
      "message.completed",
      "turn.completed"
    ])
    expect(n.providerSessionId).toBe("sess-1")
    const approval = events.find((e) => e.type === "approval.requested")
    expect(approval).toMatchObject({ providerRequestId: "req-1", toolName: "Bash", summary: "Bash: Write hi" })
    expect(events.at(-1)).toMatchObject({ status: "success", costUsd: 0.01, summary: "DONE" })
  })

  it("maps error results to error turns", () => {
    const n = new ClaudeNormalizer()
    expect(n.push({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([
      expect.objectContaining({ type: "turn.completed", status: "error" })
    ])
  })
})

describe("Claude adapter (fake CLI process)", () => {
  const adapter = makeClaudeAdapter({ binary: join(__dirname, "fake-claude.mjs") })

  it("streams a turn, round-trips an approval and accepts a follow-up", async () => {
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" }, prompt: "use a tool" })
          const seen: Array<AgentEvent> = []
          let turns = 0
          yield* session.events.pipe(
            Stream.tap((e) =>
              Effect.gen(function* () {
                seen.push(e)
                if (e.type === "approval.requested") yield* session.respondToApproval(e.providerRequestId!, "allow")
                if (e.type === "turn.completed") {
                  turns++
                  if (turns === 1) yield* session.prompt("second")
                }
              })
            ),
            Stream.takeUntil((e) => e.type === "turn.completed" && turns >= 2),
            Stream.runDrain
          )
          expect(yield* session.providerSessionId).toBe("fake-session")
          return seen
        })
      )
    )
    const types = events.map((e) => e.type)
    expect(types).toContain("approval.requested")
    expect(types.filter((t) => t === "turn.completed")).toHaveLength(2)
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ isError: false, result: "ok" })
  })

  it("reports not_installed for a missing binary", async () => {
    const missing = makeClaudeAdapter({ binary: "/nonexistent/claude" })
    const exit = await Effect.runPromiseExit(
      Effect.scoped(missing.start({ cwd: tmpdir(), policy: { permissionMode: "ask" } }))
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("not_installed")
  })
})
