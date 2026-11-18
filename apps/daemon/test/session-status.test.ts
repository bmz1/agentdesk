import type { AgentEvent, TokenUsage } from "@agentdesk/contracts"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { addTurnUsage, planSummary } from "../src/services/event-log"
import { describeEvent } from "../src/services/sessions"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe("session status line", () => {
  it("describes what the agent is doing in one bounded line", () => {
    expect(describeEvent({ type: "tool.started", toolCallId: "t", name: "Bash", input: { command: "pnpm   test\n--run" } })).toBe(
      "Bash: pnpm test --run"
    )
    expect(describeEvent({ type: "tool.started", toolCallId: "t", name: "Write", input: { file_path: "src/a.ts", content: "x" } })).toBe(
      "Write: src/a.ts"
    )
    expect(describeEvent({ type: "tool.started", toolCallId: "t", name: "TodoWrite", input: { todos: [] } })).toBe("TodoWrite")
    expect(describeEvent({ type: "approval.requested", approvalId: "a", toolName: "Bash", summary: "x".repeat(200) })!.length).toBe(96)
    expect(describeEvent({ type: "message.delta", text: "hi" })).toBe("Writing a reply")
    expect(describeEvent({ type: "turn.completed", status: "error" })).toBe("Turn failed")
    // Events that say nothing about progress leave the line as it was.
    expect(describeEvent({ type: "session.status", state: "model_changed" })).toBeUndefined()
    expect(describeEvent({ type: "approval.requested", approvalId: "q", toolName: "AskUserQuestion", kind: "question", summary: "Tabs or spaces?" })).toBe(
      "Asks: Tabs or spaces?"
    )
    expect(describeEvent({ type: "approval.resolved", approvalId: "q", decision: "allow", answers: { q: ["Tabs"] } })).toBe("Answered, continuing")
    const plan = (statuses: Array<"pending" | "in_progress" | "completed" | "cancelled">) => ({
      type: "plan.updated" as const,
      items: statuses.map((status, i) => ({ text: `Step ${i}`, status }))
    })
    expect(describeEvent(plan(["completed", "in_progress", "pending"]))).toBe("Step 2/3: Step 1")
    expect(describeEvent(plan(["completed", "completed"]))).toBe("Plan done (2/2)")
    expect(describeEvent(plan([]))).toBeUndefined()
  })
})

describe("session summaries", () => {
  it("counts plan progress without cancelled steps", () => {
    expect(planSummary([{ text: "a", status: "completed" }, { text: "b", status: "cancelled" }, { text: "c", status: "pending" }])).toEqual({
      done: 1,
      total: 2,
      current: "c"
    })
    expect(planSummary([{ text: "a", status: "cancelled" }])).toBeNull()
  })

  it("adds turns' usage, counting cached reads as input and keeping cost unknown without a price", () => {
    const turn = (usage?: TokenUsage, costUsd?: number): AgentEvent => ({
      type: "turn.completed",
      status: "success",
      ...(usage && { usage }),
      ...(costUsd !== undefined && { costUsd })
    })
    const first = addTurnUsage(null, turn({ inputTokens: 4, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 6 }))
    expect(first).toEqual({ costUsd: null, inputTokens: 1010, outputTokens: 10 })
    expect(addTurnUsage(first, turn(undefined, 0.5))).toEqual({ costUsd: 0.5, inputTokens: 1010, outputTokens: 10 })
    expect(addTurnUsage(first, turn())).toBe(first)
  })
})

describe("pushed session notices", () => {
  it("carries the session, its status line and preview, so clients need no refetch", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", { name: "Push", repoPath: makeRepo(), defaultHarness: "mock" })
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Push state" })
    const notices = api.sse("/events", (ns) => ns.some((n) => n.topic === "sessions" && n.session?.state === "idle"), 15_000)
    const session = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "write notes" })

    const approval = await waitFor(async () => (await api.get(`/approvals?pending=1`)).find((a: any) => a.sessionId === session.id))
    await api.post(`/approvals/${approval.id}/decision`, { decision: "allow" })

    const pushed = (await notices).filter((n) => n.topic === "sessions" && n.sessionId === session.id).map((n) => n.session)
    expect(pushed.every((s) => s && s.id === session.id && s.ticketId === ticket.id)).toBe(true)
    const blocked = pushed.find((s) => s.state === "waiting_for_approval")
    expect(blocked.statusDetail).toMatch(/^Needs approval: /)
    expect(blocked.preview).toBe(approval.title)
    const idle = pushed.at(-1)
    expect(idle.state).toBe("idle")
    expect(idle.statusDetail).toBe("Turn finished")
    expect(idle.preview).toBeTruthy()

    // Lists report real event ids (for unread state) and the same preview.
    const history = await api.get(`/sessions/${session.id}/history`)
    const [listed] = await api.get(`/tickets/${ticket.id}/sessions`)
    expect(listed.lastEventId).toBe(history.at(-1).id)
    expect(listed.preview).toBe(idle.preview)

    // The status line belongs to live sessions only.
    await api.post(`/sessions/${session.id}/stop`)
    const stopped = await waitFor(async () => {
      const s = await api.get(`/sessions/${session.id}`)
      return s.state === "closed" ? s : undefined
    })
    expect(stopped.statusDetail).toBeNull()
  })

  it("pages history from the end", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", { name: "Tail", repoPath: makeRepo(), defaultHarness: "mock" })
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Tail" })
    const session = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "answer only [noop]" })
    await api.sse(`/sessions/${session.id}/events`, (evs) => evs.some((e) => e.event.type === "turn.completed"))

    const all = await api.get(`/sessions/${session.id}/history`)
    expect(all.length).toBeGreaterThan(3)
    const tail = await api.get(`/sessions/${session.id}/history?tail=2`)
    expect(tail.map((e: any) => e.id)).toEqual(all.slice(-2).map((e: any) => e.id))
    const before = await api.get(`/sessions/${session.id}/history?tail=2&before=${tail[0].id}`)
    expect(before.map((e: any) => e.id)).toEqual(all.slice(-4, -2).map((e: any) => e.id))
  })
})
