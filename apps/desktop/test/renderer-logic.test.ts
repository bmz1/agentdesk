import type { StoredAgentEvent, Ticket } from "@agentdesk/contracts"
import { describe, expect, it } from "vitest"
import { groupByStatus, sortKeyBetween } from "../src/renderer/features/board/board"
import { parsePatch } from "../src/renderer/features/diff/diff-viewer"
import { TranscriptBuilder } from "../src/renderer/features/session/transcript-model"

let id = 0
const ev = (event: StoredAgentEvent["event"]): StoredAgentEvent => ({ id: ++id, sessionId: "s", at: "2026-01-01T00:00:00Z", event })

describe("TranscriptBuilder", () => {
  it("merges deltas, finalizes messages, pairs tool calls and approvals, and dedupes replays", () => {
    const b = new TranscriptBuilder()
    const events = [
      ev({ type: "user.prompt", text: "hi" }),
      ev({ type: "message.delta", messageId: "m1", text: "Hel" }),
      ev({ type: "message.delta", messageId: "m1", text: "lo" }),
      ev({ type: "message.completed", messageId: "m1", text: "Hello!" }),
      ev({ type: "tool.started", toolCallId: "t1", name: "Bash", input: { command: "ls" } }),
      ev({ type: "approval.requested", approvalId: "a1", toolName: "Bash", summary: "Bash: ls" }),
      ev({ type: "approval.resolved", approvalId: "a1", decision: "allow" }),
      ev({ type: "tool.completed", toolCallId: "t1", result: "file.txt" }),
      ev({ type: "turn.completed", status: "success" })
    ]
    b.apply(events)
    b.apply(events) // SSE reconnect replay must not duplicate
    expect(b.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "approval", "turn"])
    expect(b.items[1]).toMatchObject({ text: "Hello!", streaming: false })
    expect(b.items[2]).toMatchObject({ done: true, result: "file.txt" })
    expect(b.items[3]).toMatchObject({ decision: "allow" })
    expect(b.lastId).toBe(events.at(-1)!.id)
  })
})

describe("board ordering", () => {
  it("computes sort keys between neighbours", () => {
    expect(sortKeyBetween(undefined, undefined)).toBe(0)
    expect(sortKeyBetween(undefined, 5)).toBe(4)
    expect(sortKeyBetween(5, undefined)).toBe(6)
    expect(sortKeyBetween(1, 2)).toBe(1.5)
  })
  it("groups by status ordered by sortOrder", () => {
    const t = (id: string, status: Ticket["status"], sortOrder: number) =>
      ({ id, status, sortOrder, updatedAt: "2026-01-01" }) as Ticket
    const g = groupByStatus([t("a", "todo", 2), t("b", "todo", 1), t("c", "done", 0)])
    expect(g.get("todo")!.map((x) => x.id)).toEqual(["b", "a"])
    expect(g.get("blocked")).toEqual([])
  })
})

describe("parsePatch", () => {
  it("parses files, hunks and line numbers", () => {
    const files = parsePatch(
      "diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n"
    )
    expect(files).toHaveLength(1)
    expect(files[0]!.lines.map((l) => l.kind)).toEqual(["hunk", "ctx", "del", "add"])
    expect(files[0]!.lines[3]).toMatchObject({ newNo: 2, text: "new" })
  })
})
