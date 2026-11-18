import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const boot = async () => {
  const { daemon, api } = await startTestDaemon()
  cleanups.push(daemon.stop)
  const project = await api.post("/projects", { name: "Bridge", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "ask" })
  const start = async (prompt: string) => {
    const ticket = await api.post("/tickets", { projectId: project.id, title: prompt.slice(0, 40) })
    return { ticket, session: await api.post(`/tickets/${ticket.id}/sessions`, { prompt }) }
  }
  const pending = (sessionId: string) =>
    waitFor(async () => (await api.get("/approvals?pending=1")).find((a: any) => a.sessionId === sessionId))
  const idle = (sessionId: string) =>
    waitFor(async () => {
      const s = await api.get(`/sessions/${sessionId}`)
      return s.state === "idle" ? s : undefined
    })
  return { api, start, pending, idle }
}

describe("agent questions", () => {
  it("asks the user, requires answers, and hands them back to the agent", async () => {
    const { api, start, pending, idle } = await boot()
    const { session } = await start("pick storage [ask] [noop]")
    const question = await pending(session.id)
    expect(question).toMatchObject({
      kind: "question",
      title: "Which database should I use?",
      details: { questions: [{ id: "db", question: "Which database should I use?", allowOther: true, options: [{ label: "SQLite" }, { label: "Postgres" }] }] }
    })
    expect((await api.get(`/sessions/${session.id}`)).statusDetail).toBe("Asks: Which database should I use?")

    await expect(api.post(`/approvals/${question.id}/decision`, { decision: "allow" })).rejects.toThrow(/Answer every question/)
    await api.post(`/approvals/${question.id}/decision`, { decision: "allow", answers: { db: ["Postgres"] } })
    await idle(session.id)

    const events = (await api.get(`/sessions/${session.id}/history`)).map((e: any) => e.event)
    expect(events.find((e: any) => e.type === "approval.resolved")).toMatchObject({ decision: "allow", answers: { db: ["Postgres"] } })
    expect(events.find((e: any) => e.type === "message.completed").text).toMatch(/^You answered: Postgres\./)
    const decided = (await api.get("/approvals")).find((a: any) => a.id === question.id)
    expect(decided.decision).toBe("allow")
    const activity = await api.get(`/tickets/${session.ticketId}/activity`)
    expect(activity.some((a: any) => a.message === "Answered: Which database should I use?")).toBe(true)
  })

  it("lets the user decline to answer", async () => {
    const { api, start, pending, idle } = await boot()
    const { session } = await start("pick storage [ask] [noop]")
    const question = await pending(session.id)
    await api.post(`/approvals/${question.id}/decision`, { decision: "deny" })
    await idle(session.id)
    const events = (await api.get(`/sessions/${session.id}/history`)).map((e: any) => e.event)
    expect(events.find((e: any) => e.type === "message.completed").text).toMatch(/^You answered: \(declined\)/)
  })
})

describe("allow for this session", () => {
  it("stops asking for the same kind of action once allowed for the session", async () => {
    const { api, start, pending, idle } = await boot()
    const { session } = await start("write notes")
    const first = await pending(session.id)
    expect(first.details.canAllowForSession).toBe(true)
    await api.post(`/approvals/${first.id}/decision`, { decision: "allow", scope: "session" })
    await idle(session.id)
    const resolved = (await api.get(`/sessions/${session.id}/history`)).map((e: any) => e.event).find((e: any) => e.type === "approval.resolved")
    expect(resolved).toMatchObject({ decision: "allow", scope: "session" })

    await api.post(`/sessions/${session.id}/prompt`, { text: "write more notes" })
    await waitFor(async () => ((await api.get(`/sessions/${session.id}`)).state === "running" ? true : undefined))
    await idle(session.id)
    expect((await api.get("/approvals?pending=1")).filter((a: any) => a.sessionId === session.id)).toEqual([])
    const activity = await api.get(`/tickets/${session.ticketId}/activity`)
    expect(activity.some((a: any) => a.message.startsWith("Approved for the session"))).toBe(true)
  })
})

describe("plan progress, usage and limits", () => {
  it("tracks the agent's plan and the session's usage, pushed with the session", async () => {
    const { api, start, idle } = await boot()
    const notices = api.sse("/events", (ns) => ns.filter((n) => n.topic === "sessions" && n.session?.state === "idle").length >= 2, 15_000)
    const { session } = await start("refactor [plan] [noop]")
    const done = await idle(session.id)
    expect(done.plan).toEqual({ done: 3, total: 3, current: null })
    expect(done.usage).toEqual({ costUsd: 0.01, inputTokens: 1500, outputTokens: 100 })

    // A second turn adds up, and lists report the same totals.
    await api.post(`/sessions/${session.id}/prompt`, { text: "again [plan] [noop]" })
    const pushed = (await notices).filter((n) => n.topic === "sessions" && n.sessionId === session.id).map((n) => n.session)
    expect(pushed.some((s) => s.plan?.done === 0 && s.plan.current === "Read the code")).toBe(true)
    expect(pushed.some((s) => s.statusDetail === "Step 1/3: Read the code")).toBe(true)
    const again = await idle(session.id)
    expect(again.usage).toEqual({ costUsd: 0.02, inputTokens: 3000, outputTokens: 200 })
    const [listed] = await api.get(`/tickets/${session.ticketId}/sessions`)
    expect(listed.usage).toEqual(again.usage)
    expect(listed.plan).toEqual({ done: 3, total: 3, current: null })
  })

  it("keeps the latest rate limits per harness, outside the transcript", async () => {
    const { api, start, idle } = await boot()
    expect(await api.get("/limits")).toEqual([])
    const { session } = await start("hello [noop]")
    await idle(session.id)
    const [limits] = await api.get("/limits")
    expect(limits).toMatchObject({ harness: "mock", limited: false, windows: [{ id: "five_hour", label: "5-hour", usedPercent: 12 }] })
    const types = (await api.get(`/sessions/${session.id}/history`)).map((e: any) => e.event.type)
    expect(types).not.toContain("rate_limit")
  })

  it("says what each harness supports", async () => {
    const { api } = await boot()
    const mock = (await api.get("/harnesses/detect")).find((h: any) => h.id === "mock")
    expect(mock.capabilities).toMatchObject({ allowForSession: true, questions: true, planMode: "native" })
  })
})
