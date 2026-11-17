import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { NodeProcessLayer, parseJsonLine } from "@agentdesk/harness-core"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
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
    expect(events.find((e) => e.type === "approval.requested")).toMatchObject({
      providerRequestId: "req-1",
      toolName: "Bash",
      summary: "Bash: Write hi"
    })
    expect(events.at(-1)).toMatchObject({ status: "success", costUsd: 0.01, summary: "DONE" })
  })

  it("maps error results to error turns", () => {
    expect(new ClaudeNormalizer().push({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([
      expect.objectContaining({ type: "turn.completed", status: "error" })
    ])
  })
})

layer(NodeProcessLayer, { excludeTestServices: true })("Claude adapter (fake CLI process)", (it) => {
  const adapter = makeClaudeAdapter({ binary: join(__dirname, "fake-claude.mjs") })

  it.effect("streams a turn, round-trips an approval and accepts a follow-up", () =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" }, prompt: "use a tool" })
      const seen: Array<AgentEvent> = []
      let turns = 0
      yield* session.events.pipe(
        Stream.tap((e) =>
          Effect.gen(function* () {
            seen.push(e)
            if (e.type === "approval.requested") yield* session.respondToApproval(e.providerRequestId!, "allow")
            if (e.type === "turn.completed" && ++turns === 1) yield* session.prompt("second")
          })
        ),
        Stream.takeUntil((e) => e.type === "turn.completed" && turns >= 2),
        Stream.runDrain
      )
      expect(yield* session.providerSessionId).toBe("fake-session")
      expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2)
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ isError: false, result: "ok" })
    })
  )

  it.effect("fails with a typed not_installed error for a missing binary", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(makeClaudeAdapter({ binary: "/nonexistent/claude" }).start({ cwd: tmpdir(), policy: { permissionMode: "ask" } }))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(makeClaudeAdapter({ binary: "/nonexistent/claude" }).start({ cwd: tmpdir(), policy: { permissionMode: "ask" } }))
      expect(error).toMatchObject({ _tag: "HarnessError", reason: "not_installed" })
    })
  )
})

describe("ClaudeNormalizer images", () => {
  it("splits screenshots out of tool results into image events", () => {
    const n = new ClaudeNormalizer()
    const events = n.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "Took a screenshot" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
            ]
          }
        ]
      }
    })
    expect(events).toEqual([
      { type: "tool.completed", toolCallId: "t1", result: "Took a screenshot", isError: false },
      { type: "image", toolCallId: "t1", source: { data: "AAAA", mimeType: "image/png" } }
    ])
  })
})
