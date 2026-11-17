import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe("worktrees", () => {
  it("enforces one active writer, reuses the ticket worktree and cleans up safely", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const p = await api.post("/projects", { name: "WT", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "accept_edits" })
    const t = await api.post("/tickets", { projectId: p.id, title: "Locking" })
    const s1 = await api.post(`/tickets/${t.id}/sessions`, { prompt: "[noop] one" })
    await expect(api.post(`/tickets/${t.id}/sessions`, { prompt: "two" })).rejects.toMatchObject({ status: 400 })
    const ws = await api.get(`/tickets/${t.id}/workspace`)
    expect(ws.branch).toMatch(/^agentdesk\/wt-1-locking-/)
    // Cleanup refused while the session holds the writer lock.
    await expect(api.post(`/workspaces/${ws.id}/cleanup`)).rejects.toMatchObject({ status: 409 })

    await api.post(`/sessions/${s1.id}/stop`)
    await waitFor(async () => ((await api.get(`/sessions/${s1.id}`)).state === "closed" ? true : undefined))
    const s2 = await api.post(`/tickets/${t.id}/sessions`, { prompt: "[noop] again" })
    expect(s2.cwd).toBe(s1.cwd)
    await api.post(`/sessions/${s2.id}/stop`)
    await waitFor(async () => ((await api.get(`/sessions/${s2.id}`)).state === "closed" ? true : undefined))

    writeFileSync(join(ws.path, "dirty.txt"), "uncommitted")
    await expect(api.post(`/workspaces/${ws.id}/cleanup`)).rejects.toMatchObject({ status: 409 })
    const removed = await api.post(`/workspaces/${ws.id}/cleanup?force=1`)
    expect(removed.cleanupState).toBe("removed")
    expect(existsSync(ws.path)).toBe(false)
  })
})
