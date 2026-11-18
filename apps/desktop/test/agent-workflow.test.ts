import type { AgentSession, Ticket } from "@agentdesk/contracts"
import { describe, expect, it } from "vitest"
import { agentGroup, isSessionUnread, SESSION_LABELS, ticketSession } from "../src/renderer/lib/agent-state"
import { reviewPrompt } from "../src/renderer/lib/review"
import type { ReviewComment } from "../src/renderer/lib/store"
import { validateIssuesSearch } from "../src/renderer/features/board/issues-view"

const session = (id: string, state: AgentSession["state"], createdAt = "2026-11-17T12:00:00Z") =>
  ({ id, ticketId: "t", state, createdAt, lastEventId: 25 }) as AgentSession

describe("agent attention", () => {
  it("keeps actionable failures and approvals apart from working and completed turns", () => {
    expect(agentGroup("waiting_for_approval")).toBe("attention")
    expect(agentGroup("failed")).toBe("attention")
    expect(agentGroup("interrupted")).toBe("attention")
    expect(agentGroup("running")).toBe("working")
    expect(agentGroup("starting")).toBe("working")
    expect(agentGroup("idle")).toBe("followup")
    expect(agentGroup("completed")).toBe("recent")
    expect(agentGroup("closed")).toBe("recent")
    expect(SESSION_LABELS.completed).toBe("Turn finished")
  })
  it("only marks new non-running events unread and supports marking a session unread again", () => {
    const s = session("s", "idle")
    expect(isSessionUnread(s, {})).toBe(true)
    expect(isSessionUnread(s, { s: 25 })).toBe(false)
    expect(isSessionUnread({ ...s, lastEventId: 26 }, { s: 25 })).toBe(true)
    expect(isSessionUnread(s, { s: -1 })).toBe(true)
    expect(isSessionUnread({ ...s, state: "running" }, {})).toBe(false)
    expect(isSessionUnread({ ...s, state: "running" }, { s: -1 })).toBe(true)
  })
  it("uses the active or newest attempt so an old failure does not mask new work", () => {
    const old = session("old", "failed", "2026-11-16T12:00:00Z")
    const latest = session("new", "running")
    const ticket = { id: "t", activeSessionId: "new" } as Ticket
    expect(ticketSession(ticket, [old, latest])?.id).toBe("new")
    expect(ticketSession({ ...ticket, activeSessionId: null }, [old, latest])?.id).toBe("new")
    expect(ticketSession(ticket, [])).toBeUndefined()
  })
})

describe("review feedback", () => {
  it("batches unresolved comments with original file, diff side, line and code", () => {
    const comment: ReviewComment = {
      id: "c",
      path: "src/a.ts",
      side: "old",
      line: 12,
      code: "return null",
      text: "Handle this case",
      resolved: false
    }
    const prompt = reviewPrompt([comment, { ...comment, id: "resolved", text: "Already fixed", resolved: true }])
    expect(prompt).toContain("src/a.ts (old line 12)")
    expect(prompt).toContain('Code: "return null"')
    expect(prompt).toContain("Handle this case")
    expect(prompt).not.toContain("Already fixed")
    expect(reviewPrompt([{ ...comment, sentAt: "yesterday" }])).toContain("Handle this case")
  })
})

describe("saved issue filters", () => {
  it("validates restored and linked filters, including boolean URL values", () => {
    expect(validateIssuesSearch({ view: "list", harness: "codex", attention: "true", q: "bug" })).toMatchObject({
      view: "list",
      harness: "codex",
      attention: true,
      q: "bug"
    })
    expect(validateIssuesSearch({ harness: "invalid", attention: "false", source: "bad/source" })).toMatchObject({
      harness: undefined,
      attention: undefined,
      source: undefined
    })
  })
})
