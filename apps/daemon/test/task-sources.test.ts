import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeFakeJira } from "../../../packages/jira/test/fake-jira"
import { makeFakeLinear } from "../../../packages/linear/test/fake-linear"
import { makeRepo, startTestDaemon } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const TOKEN = "super-secret-jira-token-123"

describe("Jira via the deprecated /jira/* aliases (read-only sync)", () => {
  it("imports, refreshes and detects out-of-scope issues without mutating Jira", async () => {
    const fake = makeFakeJira({
      deployment: "cloud",
      issues: [
        { id: "10001", key: "SEON-1", summary: "Fraud rule editor", category: "indeterminate", status: "In Progress", labels: ["fraud"] },
        { id: "10002", key: "SEON-2", summary: "Export CSV", description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "<img src=x onerror=alert(1)>" }] }] } },
        { id: "10003", key: "SEON-3", summary: "Done thing", category: "done", status: "Done" }
      ],
      pageSize: 2
    })
    const { daemon, api, dataDir } = await startTestDaemon({ sources: { fetch: fake.fetch, retryBaseMs: 1 }, credentialStore: "memory" })
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", { name: "Seon", key: "SN", repoPath: makeRepo() })
    const local = await api.post("/tickets", { projectId: project.id, title: "Local spike" })

    const conn = await api.post("/jira/connections", {
      name: "SEON Cloud",
      deployment: "cloud",
      baseUrl: "https://seon.atlassian.net",
      principal: "me@seon.io",
      token: TOKEN,
      jql: "project = SEON ORDER BY updated DESC",
      projectId: project.id
    })
    expect(conn).toMatchObject({ hasCredential: true, enabled: true })
    expect(JSON.stringify(conn)).not.toContain(TOKEN)

    const first = await api.post(`/jira/connections/${conn.id}/sync`)
    expect(first).toMatchObject({ fetched: 3, created: 3, updated: 0, full: true })

    // Imports are global: they wait unassigned next to the project's local ticket.
    let tickets = await api.get("/tickets")
    expect(tickets).toHaveLength(4)
    expect(tickets.filter((t: any) => t.projectId === null)).toHaveLength(3)
    const seon1 = tickets.find((t: any) => t.identifier === "SEON-1")
    expect(seon1).toMatchObject({ source: "jira", status: "in_progress", labels: ["fraud"] })
    expect(seon1.external).toMatchObject({ remoteStatus: "In Progress", url: "https://seon.atlassian.net/browse/SEON-1", remoteState: "active" })
    expect(tickets.find((t: any) => t.identifier === "SEON-3").status).toBe("done")
    // Untrusted HTML stays inert text.
    expect(tickets.find((t: any) => t.identifier === "SEON-2").description).toBe("<img src=x onerror=alert(1)>")
    expect(tickets.find((t: any) => t.id === local.id).source).toBe("local")

    // Local board moves never reach Jira; Jira-owned fields are read-only.
    await api.patch(`/tickets/${seon1.id}`, { status: "in_review" })
    await expect(api.patch(`/tickets/${seon1.id}`, { title: "hacked" })).rejects.toMatchObject({ status: 400 })

    // Remote update + removal from scope.
    fake.state.issues[0] = { ...fake.state.issues[0]!, summary: "Fraud rule editor v2", status: "In Review", updated: "2026-11-02T10:00:00.000+0000" }
    fake.state.issues.splice(1, 1)
    const second = await api.post(`/jira/connections/${conn.id}/sync?full=1`)
    expect(second).toMatchObject({ created: 0, updated: 1, missing: 1 })
    tickets = await api.get("/tickets")
    const s1 = tickets.find((t: any) => t.identifier === "SEON-1")
    expect(s1).toMatchObject({ title: "Fraud rule editor v2", status: "in_review" })
    expect(s1.external.remoteStatus).toBe("In Review")
    expect(tickets.find((t: any) => t.identifier === "SEON-2").external.remoteState).toBe("missing")
    const history = await api.get(`/tickets/${s1.id}/activity`)
    expect(history.some((a: any) => a.message.includes("In Progress → In Review"))).toBe(true)

    // Incremental sync narrows JQL by watermark.
    await api.post(`/jira/connections/${conn.id}/sync`)
    expect(fake.state.calls.at(-1)!.body.jql).toMatch(/^\(project = SEON\) AND updated >= ".+" ORDER BY updated DESC$/)

    // Only read endpoints were ever called.
    expect(new Set(fake.state.calls.map((c) => c.path))).toEqual(new Set(["/rest/api/3/search/jql"]))
    // Token never lands in SQLite.
    expect(readFileSync(join(dataDir, "agentdesk.db")).includes(Buffer.from(TOKEN))).toBe(false)
  })

  it("records failures and surfaces auth errors", async () => {
    const fake = makeFakeJira({ deployment: "datacenter", issues: [] })
    fake.state.failAuth = true
    const { daemon, api } = await startTestDaemon({ sources: { fetch: fake.fetch, retryBaseMs: 1 }, credentialStore: "memory" })
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", { name: "DC", repoPath: makeRepo() })
    const conn = await api.post("/jira/connections", {
      name: "DC",
      deployment: "datacenter",
      baseUrl: "https://jira.example.com",
      principal: "",
      token: "pat",
      jql: "assignee = currentUser()",
      projectId: project.id
    })
    await expect(api.post(`/jira/connections/${conn.id}/sync`)).rejects.toMatchObject({ status: 502 })
    const [c] = await api.get("/jira/connections")
    expect(c.lastError).toContain("rejected credentials")
    expect((await api.post(`/jira/connections/${conn.id}/test`)).ok).toBe(false)
    await expect(
      api.post("/jira/connections", { name: "x", deployment: "cloud", baseUrl: "http://evil.example", principal: "a", jql: "x", projectId: project.id })
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe("generic task sources API", () => {
  it("lists available sources with form descriptors", async () => {
    const { daemon, api } = await startTestDaemon({ credentialStore: "memory" })
    cleanups.push(daemon.stop)
    const sources = await api.get("/sources")
    expect(sources.map((s: any) => s.id)).toEqual(["jira", "linear"])
    expect(sources[1].fields.map((f: any) => f.key)).toEqual(["teamKey", "assignee", "states", "label"])
    expect(sources[1].credential).toMatchObject({ label: "Personal API key", required: true })
  })

  it("imports Linear and Jira tasks side by side through one interface", async () => {
    const jira = makeFakeJira({ deployment: "cloud", issues: [{ id: "10001", key: "SEON-1", summary: "Jira issue" }] })
    const linear = makeFakeLinear({
      issues: [
        { id: "lin-1", identifier: "ENG-1", title: "Linear started", isMine: true },
        { id: "lin-2", identifier: "ENG-2", title: "Linear backlog", isMine: true, stateType: "backlog", stateName: "Backlog" },
        { id: "lin-3", identifier: "ENG-3", title: "Done already", isMine: true, stateType: "completed" }
      ]
    })
    // One injected fetch for every source, routed by host.
    const fetch = ((url: string, init?: RequestInit) =>
      (String(url).includes("linear.app") ? linear.fetch : jira.fetch)(url, init)) as typeof globalThis.fetch
    const { daemon, api } = await startTestDaemon({ sources: { fetch, retryBaseMs: 1 }, credentialStore: "memory" })
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", { name: "Mixed", key: "MX", repoPath: makeRepo() })

    // Settings are validated by the adapter's schema.
    await expect(
      api.post("/sources/connections", { provider: "linear", name: "bad", projectId: project.id, settings: { teamKey: "" } })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      api.post("/sources/connections", { provider: "trello", name: "x", projectId: project.id, settings: {} })
    ).rejects.toMatchObject({ status: 400 })

    const lin = await api.post("/sources/connections", {
      provider: "linear",
      name: "ENG",
      projectId: project.id,
      token: "lin_api_key",
      settings: { teamKey: "ENG", assignee: "mine", states: "open" }
    })
    expect(lin).toMatchObject({ provider: "linear", hasCredential: true, settings: { teamKey: "ENG" } })
    const jc = await api.post("/sources/connections", {
      provider: "jira",
      name: "SEON",
      projectId: project.id,
      token: "jira-token",
      settings: { deployment: "cloud", baseUrl: "https://seon.atlassian.net", principal: "me@seon.io", jql: "project = SEON" }
    })

    expect(await api.post(`/sources/connections/${lin.id}/test`)).toEqual({ ok: true, message: "Authenticated as Ada" })
    expect(await api.post(`/sources/connections/${lin.id}/sync`)).toMatchObject({ fetched: 2, created: 2, full: true })
    expect(await api.post(`/sources/connections/${jc.id}/sync`)).toMatchObject({ fetched: 1, created: 1 })

    const tickets = await api.get("/tickets?unassigned=1")
    const byKey = Object.fromEntries(tickets.map((t: any) => [t.identifier, t]))
    expect(Object.keys(byKey).sort()).toEqual(["ENG-1", "ENG-2", "SEON-1"])
    expect(byKey["ENG-1"]).toMatchObject({ source: "linear", status: "in_progress" })
    expect(byKey["ENG-2"]).toMatchObject({ source: "linear", status: "todo" })
    expect(byKey["ENG-1"].external).toMatchObject({ provider: "linear", url: "https://linear.app/acme/issue/ENG-1", remoteStatus: "In Progress" })
    expect(byKey["SEON-1"]).toMatchObject({ source: "jira" })
    expect((await api.get("/tickets?source=linear")).length).toBe(2)
    // Remote-owned fields are read-only for every source.
    await expect(api.patch(`/tickets/${byKey["ENG-1"].id}`, { title: "x" })).rejects.toMatchObject({ status: 400 })

    // Incremental sync narrows by updatedAt; full sync detects issues that left the scope.
    await api.post(`/sources/connections/${lin.id}/sync`)
    expect(linear.state.calls.at(-1)!.variables.filter.updatedAt).toBeDefined()
    linear.state.issues.splice(1, 1)
    expect(await api.post(`/sources/connections/${lin.id}/sync?full=1`)).toMatchObject({ missing: 1 })
    expect((await api.get(`/tickets/${byKey["ENG-2"].id}`)).external.remoteState).toBe("missing")

    // Auth failures are typed and recorded per connection.
    linear.state.failAuth = true
    await expect(api.post(`/sources/connections/${lin.id}/sync`)).rejects.toMatchObject({ status: 502 })
    const conns = await api.get("/sources/connections")
    expect(conns.find((c: any) => c.id === lin.id).lastError).toContain("rejected the API key")
    // Legacy alias only shows Jira connections, in the old flat shape.
    const legacy = await api.get("/jira/connections")
    expect(legacy).toHaveLength(1)
    expect(legacy[0]).toMatchObject({ id: jc.id, jql: "project = SEON", deployment: "cloud" })
  })
})

describe("global task-source tickets", () => {
  const setup = async () => {
    const fake = makeFakeJira({
      deployment: "cloud",
      issues: [
        { id: "1", key: "SEON-1", summary: "Fraud rules" },
        { id: "2", key: "PAY-7", summary: "Refunds" },
        { id: "3", key: "SEON-2", summary: "Rule export" }
      ]
    })
    const { daemon, api } = await startTestDaemon({ sources: { fetch: fake.fetch, retryBaseMs: 1 }, credentialStore: "memory" })
    cleanups.push(daemon.stop)
    const a = await api.post("/projects", { name: "Alpha", key: "AL", repoPath: makeRepo(), defaultHarness: "mock" })
    const b = await api.post("/projects", { name: "Beta", key: "BE", repoPath: makeRepo(), defaultHarness: "mock" })
    const conn = await api.post("/sources/connections", {
      provider: "jira",
      name: "All my Jira",
      token: "t",
      settings: { deployment: "cloud", baseUrl: "https://acme.atlassian.net", principal: "me@acme.io", jql: "assignee = currentUser()" }
    })
    await api.post(`/sources/connections/${conn.id}/sync`)
    const byKey = async () => Object.fromEntries((await api.get("/tickets")).map((t: any) => [t.identifier, t]))
    return { api, fake, conn, a, b, byKey }
  }

  it("imports tickets without a project and assigns, moves and unassigns them on demand", async () => {
    const { api, fake, conn, a, b, byKey } = await setup()
    expect(conn).not.toHaveProperty("projectId")
    let t = await byKey()
    expect(Object.values(t).map((x: any) => x.projectId)).toEqual([null, null, null])
    expect((await api.get("/tickets?unassigned=1")).length).toBe(3)

    // Tickets from one Jira project can go to different local projects, and numbers are per project.
    const seon1 = await api.patch(`/tickets/${t["SEON-1"].id}`, { projectId: a.id })
    expect(seon1).toMatchObject({ projectId: a.id, number: 1, identifier: "SEON-1" })
    expect(await api.patch(`/tickets/${t["SEON-2"].id}`, { projectId: b.id })).toMatchObject({ projectId: b.id, number: 1 })
    const local = await api.post("/tickets", { projectId: a.id, title: "Local" })
    expect(local.number).toBe(2)
    expect((await api.get(`/tickets?projectId=${a.id}`)).map((x: any) => x.identifier).sort()).toEqual(["AL-2", "SEON-1"])
    expect((await api.get("/tickets?unassigned=1")).map((x: any) => x.identifier)).toEqual(["PAY-7"])

    // Moving takes the next number in the target project, so it never collides there.
    expect(await api.patch(`/tickets/${t["SEON-1"].id}`, { projectId: b.id })).toMatchObject({ projectId: b.id, number: 2 })
    // Imported tickets can go back to unassigned; local tickets always keep a project.
    expect(await api.patch(`/tickets/${t["SEON-1"].id}`, { projectId: null })).toMatchObject({ projectId: null, number: 0 })
    await expect(api.patch(`/tickets/${local.id}`, { projectId: null })).rejects.toMatchObject({ status: 400 })
    await expect(api.patch(`/tickets/${t["PAY-7"].id}`, { projectId: "nope" })).rejects.toMatchObject({ status: 404 })
    const history = await api.get(`/tickets/${t["SEON-1"].id}/activity`)
    expect(history.map((h: any) => h.message)).toEqual(expect.arrayContaining(["Assigned to Alpha", "Moved from Alpha to Beta", "Unassigned from Beta"]))

    // Syncing again never touches the local assignment.
    await api.patch(`/tickets/${t["PAY-7"].id}`, { projectId: a.id })
    fake.state.issues[1] = { ...fake.state.issues[1]!, summary: "Refunds v2", updated: "2026-11-03T10:00:00.000+0000" }
    expect(await api.post(`/sources/connections/${conn.id}/sync?full=1`)).toMatchObject({ created: 0, updated: 1 })
    t = await byKey()
    expect(t["PAY-7"]).toMatchObject({ projectId: a.id, title: "Refunds v2" })
  })

  it("refuses agents and workflows until a ticket has a project, and moves while an agent works", async () => {
    const { api, a, b, byKey } = await setup()
    const t = (await byKey())["SEON-1"]
    await expect(api.post(`/tickets/${t.id}/sessions`, { prompt: "go" })).rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining("not assigned to a project") } })
    await expect(api.post(`/tickets/${t.id}/start-run`, {})).rejects.toMatchObject({ status: 400 })

    await api.patch(`/tickets/${t.id}`, { projectId: a.id })
    const s = await api.post(`/tickets/${t.id}/sessions`, { prompt: "go" })
    await expect(api.patch(`/tickets/${t.id}`, { projectId: b.id })).rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining("Stop the active agent") } })
    await api.post(`/sessions/${s.id}/stop`)
    expect(await api.patch(`/tickets/${t.id}`, { projectId: b.id })).toMatchObject({ projectId: b.id })
  })
})
