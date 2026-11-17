import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeFakeJira } from "../../../packages/jira/test/fake-jira"
import { makeRepo, startTestDaemon } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const TOKEN = "super-secret-jira-token-123"

describe("Jira read-only sync", () => {
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
    const { daemon, api, dataDir } = await startTestDaemon({ jira: { fetch: fake.fetch, retryBaseMs: 1 }, credentialStore: "memory" })
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

    let tickets = await api.get(`/tickets?projectId=${project.id}`)
    expect(tickets).toHaveLength(4)
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
    tickets = await api.get(`/tickets?projectId=${project.id}`)
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
    const { daemon, api } = await startTestDaemon({ jira: { fetch: fake.fetch, retryBaseMs: 1 }, credentialStore: "memory" })
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
