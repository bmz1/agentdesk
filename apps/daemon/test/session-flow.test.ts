import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe("first milestone: ticket → headless agent in a worktree → live transcript → follow-up → replay", () => {
  it("runs the full flow through the HTTP API", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    const project = await api.post("/projects", { name: "Demo App", repoPath: repo, defaultHarness: "mock" })
    expect(project).toMatchObject({ key: "DA", defaultBranch: "main", permissionMode: "ask" })

    const ticket = await api.post("/tickets", { projectId: project.id, title: "Add notes file", description: "Write notes" })
    expect(ticket.identifier).toBe("DA-1")
    expect(ticket.source).toBe("local")

    const session = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "please write notes" })
    expect(session.harness).toBe("mock")
    expect(session.cwd).not.toBe(repo)
    expect(session.cwd).toContain("worktrees")

    // Follow the live stream; approve the tool call when it arrives.
    let approved = false
    const firstTurn = await api.sse(`/sessions/${session.id}/events`, (evs) => {
      const approval = evs.find((e) => e.event.type === "approval.requested")
      if (approval && !approved) {
        approved = true
        void api.post(`/approvals/${approval.event.approvalId}/decision`, { decision: "allow" })
      }
      return evs.some((e) => e.event.type === "turn.completed")
    })
    const types = firstTurn.map((e) => e.event.type)
    expect(types[0]).toBe("user.prompt")
    expect(types).toContain("session.started")
    expect(types).toContain("approval.resolved")
    // Event ids are strictly increasing.
    const ids = firstTurn.map((e) => e.id)
    expect([...ids].sort((a, b) => a - b)).toEqual(ids)
    expect(readFileSync(join(session.cwd, "AGENTDESK_NOTES.md"), "utf8")).toContain("please write notes")
    expect(existsSync(join(repo, "AGENTDESK_NOTES.md"))).toBe(false)

    // The ticket shows the active session; the turn left changes, so it is ready for review.
    const t2 = await waitFor(async () => {
      const t = await api.get(`/tickets/${ticket.id}`)
      return t.status === "in_review" ? t : undefined
    })
    expect(t2.activeSessionId).toBe(session.id)

    // Follow-up prompt on the same live session.
    const lastId = ids.at(-1)
    await api.post(`/sessions/${session.id}/prompt`, { text: "now a follow-up [noop]" })
    const second = await api.sse(`/sessions/${session.id}/events?after=${lastId}`, (evs) =>
      evs.some((e) => e.event.type === "turn.completed")
    )
    expect(second[0].event).toEqual({ type: "user.prompt", text: "now a follow-up [noop]" })
    expect(second.every((e) => e.id > lastId)).toBe(true)

    // Reopening the page replays the full history from the durable log.
    const history = await api.get(`/sessions/${session.id}/history`)
    expect(history.length).toBe(firstTurn.length + second.length)

    // Diff shows the change in the worktree.
    const diff = await api.get(`/tickets/${ticket.id}/diff`)
    expect(diff.files.map((f: any) => f.path)).toContain("AGENTDESK_NOTES.md")

    await api.post(`/sessions/${session.id}/stop`)
    await waitFor(async () => (await api.get(`/sessions/${session.id}`)).state === "closed" || undefined)
  })

  it("rejects unauthenticated requests, foreign origins and rebinding hosts", async () => {
    const { daemon } = await startTestDaemon()
    cleanups.push(daemon.stop)
    expect((await fetch(daemon.url + "/projects")).status).toBe(401)
    expect(
      (await fetch(daemon.url + "/projects", { headers: { authorization: "Bearer test-token", origin: "https://evil.example" } }))
        .status
    ).toBe(403)
    expect((await fetch(daemon.url + "/health")).status).toBe(200)
    const ok = await fetch(daemon.url + "/projects", {
      headers: { authorization: "Bearer test-token", origin: "http://localhost:5173" }
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173")
  })

  it("keeps a conversation waiting for a follow-up across a daemon restart, without error states", async () => {
    const first = await startTestDaemon()
    const repo = makeRepo()
    const project = await first.api.post("/projects", { name: "Restart", repoPath: repo, defaultHarness: "mock", permissionMode: "accept_edits" })
    const ticket = await first.api.post("/tickets", { projectId: project.id, title: "Survive restarts" })
    const session = await first.api.post(`/tickets/${ticket.id}/sessions`, { prompt: "[noop] hi" })
    await first.api.sse(`/sessions/${session.id}/events`, (evs) => evs.some((e) => e.event.type === "turn.completed"))
    await first.daemon.stop()

    const second = await startTestDaemon({}, first.dataDir)
    cleanups.push(second.daemon.stop)
    const s = await second.api.get(`/sessions/${session.id}`)
    expect(s.state).toBe("idle")
    const before = await second.api.get(`/sessions/${session.id}/history`)
    expect(before.some((e: any) => e.event.type === "session.status" && ["interrupted", "restarted"].includes(e.event.state))).toBe(false)
    await second.api.post(`/sessions/${session.id}/prompt`, { text: "continue [noop]" })
    const evs = await second.api.sse(`/sessions/${session.id}/events`, (e) =>
      e.filter((x) => x.event.type === "turn.completed").length >= 2
    )
    expect(evs.some((e) => e.event.type === "session.status" && e.event.state === "resuming")).toBe(true)
  })
})
