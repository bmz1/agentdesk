import { makeMockAdapter } from "@agentdesk/harness-core"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const history = (api: any, id: string) => api.get(`/sessions/${id}/history`) as Promise<Array<any>>
const turns = (api: any, id: string, n: number) =>
  waitFor(async () => {
    const h = await history(api, id)
    return h.filter((e) => e.event.type === "turn.completed").length >= n ? h : undefined
  })

describe("switching model and effort from the composer", () => {
  it("applies to the live session, sticks on the ticket, and relaunches when effort is launch-only", async () => {
    const { daemon, api } = await startTestDaemon({ adapters: [makeMockAdapter({ delayMs: 1, effortAtLaunchOnly: true })] })
    cleanups.push(daemon.stop)
    const p = await api.post("/projects", { name: "Switch", key: "SW", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "accept_edits" })
    const t = await api.post("/tickets", { projectId: p.id, title: "Switch things" })
    const s = await api.post(`/tickets/${t.id}/sessions`, { prompt: "First [noop]" })
    await turns(api, s.id, 1)

    // A model switch goes to the live process and is remembered by the ticket.
    await api.post(`/sessions/${s.id}/prompt`, { text: "Second [noop]", model: "mock-2" })
    await turns(api, s.id, 2)
    expect(await api.get(`/tickets/${t.id}`)).toMatchObject({ model: "mock-2", effort: null })
    expect((await history(api, s.id)).filter((e) => e.event.type === "session.started")).toHaveLength(1)

    // Effort is launch-only for this harness: same session and conversation, new process with the new effort.
    await api.post(`/sessions/${s.id}/prompt`, { text: "Third [noop]", effort: "high" })
    const h = await turns(api, s.id, 3)
    const starts = h.filter((e) => e.event.type === "session.started")
    expect(starts).toHaveLength(2)
    expect(starts[1].event).toMatchObject({ model: "mock-2@high", providerSessionId: starts[0].event.providerSessionId })
    expect(h.some((e) => e.event.type === "session.status" && e.event.state === "effort_changed")).toBe(true)
    expect(await api.get(`/tickets/${t.id}`)).toMatchObject({ model: "mock-2", effort: "high" })
    expect((await api.get(`/sessions/${s.id}`)).state).toBe("idle")
    // A relaunch is not an ended session.
    const activity = await api.get(`/tickets/${t.id}/activity`)
    expect(activity.some((a: any) => a.kind === "session.ended")).toBe(false)

    // Changing the model resets effort to the new model's default.
    await api.patch(`/tickets/${t.id}`, { model: "mock-3" })
    expect(await api.get(`/tickets/${t.id}`)).toMatchObject({ model: "mock-3", effort: null })
  })
})
