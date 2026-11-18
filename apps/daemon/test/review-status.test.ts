import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const turns = async (api: any, sessionId: string, n: number) =>
  waitFor(async () => {
    const h = await api.get(`/sessions/${sessionId}/history`)
    return h.filter((e: any) => e.event.type === "turn.completed").length >= n || undefined
  })

describe("board status follows ad-hoc agent work", () => {
  it("moves to In review when a turn leaves changes, and back on follow-up", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const p = await api.post("/projects", {
      name: "Rev",
      key: "REV",
      repoPath: makeRepo(),
      defaultHarness: "mock",
      permissionMode: "accept_edits"
    })

    // A turn that only answers leaves the ticket in progress.
    const q = await api.post("/tickets", { projectId: p.id, title: "Question" })
    const qs = await api.post(`/tickets/${q.id}/sessions`, { prompt: "Just explain the code [noop]" })
    await turns(api, qs.id, 1)
    expect((await api.get(`/tickets/${q.id}`)).status).toBe("in_progress")

    // A turn that writes files is ready for review.
    const t = await api.post("/tickets", { projectId: p.id, title: "Change" })
    const s = await api.post(`/tickets/${t.id}/sessions`, { prompt: "Make the change" })
    await waitFor(async () => (await api.get(`/tickets/${t.id}`)).status === "in_review" || undefined)

    // A follow-up puts it back in progress; the finished turn (changes still present) returns it to review.
    await api.post(`/sessions/${s.id}/prompt`, { text: "Tweak it [slow]" })
    expect((await api.get(`/tickets/${t.id}`)).status).toBe("in_progress")
    await turns(api, s.id, 2)
    await waitFor(async () => (await api.get(`/tickets/${t.id}`)).status === "in_review" || undefined)

    // Manual states are never overridden.
    await api.patch(`/tickets/${t.id}`, { status: "blocked" })
    await api.post(`/sessions/${s.id}/prompt`, { text: "More [noop]" })
    await turns(api, s.id, 3)
    expect((await api.get(`/tickets/${t.id}`)).status).toBe("blocked")
  })
})
