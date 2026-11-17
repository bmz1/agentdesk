import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe("projects and local tickets", () => {
  it("validates repositories and derives keys", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    await expect(api.post("/projects", { name: "Nope", repoPath: "/definitely/not/here" })).rejects.toMatchObject({ status: 400 })
    const repo = makeRepo()
    const p = await api.post("/projects", { name: "payments service", repoPath: repo })
    expect(p.key).toBe("PS")
    await expect(api.post("/projects", { name: "Dup", key: "PS", repoPath: repo })).rejects.toMatchObject({ status: 409 })
    const updated = await api.patch(`/projects/${p.id}`, { testCommand: "pnpm test", defaultHarness: "mock" })
    expect(updated).toMatchObject({ testCommand: "pnpm test", defaultHarness: "mock" })
  })

  it("supports CRUD, search, ordering and board moves, and survives restarts", async () => {
    const first = await startTestDaemon()
    const repo = makeRepo()
    const p = await first.api.post("/projects", { name: "Web", key: "WEB", repoPath: repo })
    const a = await first.api.post("/tickets", { projectId: p.id, title: "Refactor payment gateway", description: "Stripe adapter" })
    const b = await first.api.post("/tickets", { projectId: p.id, title: "Dark mode", priority: "high", labels: ["ui"] })
    expect([a.identifier, b.identifier]).toEqual(["WEB-1", "WEB-2"])
    // Newly created tickets go to the top of their column.
    expect(b.sortOrder).toBeLessThan(a.sortOrder)

    expect((await first.api.get("/tickets?q=payment")).map((t: any) => t.id)).toEqual([a.id])
    expect((await first.api.get("/tickets?q=strip")).map((t: any) => t.id)).toEqual([a.id])
    expect((await first.api.get("/tickets?q=WEB-2")).map((t: any) => t.id)).toEqual([b.id])
    expect(await first.api.get("/tickets?q=nomatch")).toEqual([])

    const moved = await first.api.patch(`/tickets/${a.id}`, { status: "in_review", sortOrder: 2.5 })
    expect(moved).toMatchObject({ status: "in_review", sortOrder: 2.5 })
    expect((await first.api.get(`/tickets?status=in_review`)).length).toBe(1)
    const activity = await first.api.get(`/tickets/${a.id}/activity`)
    expect(activity[0].message).toContain("local board only")

    await expect(first.api.post("/tickets", { projectId: p.id, title: "" })).rejects.toMatchObject({ status: 400 })
    await expect(first.api.patch(`/tickets/missing`, { title: "x" })).rejects.toMatchObject({ status: 404 })
    await first.daemon.stop()

    const second = await startTestDaemon({}, first.dataDir)
    cleanups.push(second.daemon.stop)
    const all = await second.api.get("/tickets")
    expect(all).toHaveLength(2)
    expect(all.find((t: any) => t.id === a.id).status).toBe("in_review")
    await second.api.del(`/tickets/${b.id}`)
    expect(await second.api.get("/tickets")).toHaveLength(1)
    await expect(second.api.del(`/projects/${p.id}`)).rejects.toMatchObject({ status: 409 })
  })
})
