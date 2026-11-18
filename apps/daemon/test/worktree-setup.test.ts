import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import Database from "better-sqlite3"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const boot = async (setupCommand?: string) => {
  const { daemon, api } = await startTestDaemon()
  cleanups.push(daemon.stop)
  const repo = makeRepo()
  const project = await api.post("/projects", {
    name: "Setup",
    repoPath: repo,
    defaultHarness: "mock",
    ...(setupCommand && { setupCommand })
  })
  return { api, repo, project }
}

const stateOf = (api: any, id: string, states: Array<string>) =>
  waitFor(async () => {
    const s = await api.get(`/sessions/${id}`)
    return states.includes(s.state) ? s : undefined
  }, 15_000)

const setupEvents = async (api: any, sessionId: string) =>
  (await api.get(`/sessions/${sessionId}/history`)).map((e: any) => e.event).filter((e: any) => e.toolCallId === "agentdesk-setup")

describe("every agent works in its own worktree", () => {
  it("starts threads in a new worktree, never the main checkout", async () => {
    const { api, repo, project } = await boot()
    // Old clients may still ask for a read-only thread: it gets a worktree like any other.
    const thread = await api.post("/tickets", { projectId: project.id, title: "Brainstorm", tracked: false, workspaceMode: "readonly" })
    expect(thread).not.toHaveProperty("workspaceMode")
    const session = await api.post(`/tickets/${thread.id}/sessions`, { prompt: "think about it [noop]" })
    expect(session.cwd).not.toBe(repo)
    const ws = await api.get(`/tickets/${thread.id}/workspace`)
    expect(ws).toMatchObject({ path: session.cwd, cleanupState: "active", setupState: "pending" })
    // Without a setup script the agent starts at once, with no setup step.
    await stateOf(api, session.id, ["idle"])
    expect(await setupEvents(api, session.id)).toEqual([])
  })

  it("refuses to resume a conversation that ran in the main checkout (a read-only thread from before)", async () => {
    const { daemon, api, dataDir } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    const project = await api.post("/projects", { name: "Legacy", repoPath: repo, defaultHarness: "mock" })
    const thread = await api.post("/tickets", { projectId: project.id, title: "Old thread", tracked: false })
    const session = await api.post(`/tickets/${thread.id}/sessions`, { prompt: "hello [noop]" })
    await stateOf(api, session.id, ["idle"])
    await api.post(`/sessions/${session.id}/stop`)
    await stateOf(api, session.id, ["closed"])
    // What an upgraded database holds for a read-only thread's session.
    const db = new Database(join(dataDir, "agentdesk.db"))
    db.prepare("UPDATE agent_sessions SET workspace_id = NULL, cwd = ? WHERE id = ?").run(repo, session.id)
    db.close()
    await expect(api.post(`/sessions/${session.id}/prompt`, { text: "continue" })).rejects.toThrow(/main checkout/)
    // A new session from the thread gets a worktree.
    const next = await api.post(`/tickets/${thread.id}/sessions`, { prompt: "continue [noop]" })
    expect(next.cwd).not.toBe(repo)
  })
})

describe("worktree setup script", () => {
  it("runs once in a new worktree before the agent starts, with the worktree's paths", async () => {
    const { api, repo, project } = await boot(
      'printf "%s|%s|%s" "$AGENTDESK_ROOT_PATH" "$AGENTDESK_WORKSPACE_PATH" "$PWD" > .setup-ran; echo installed'
    )
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Needs deps" })
    const session = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "answer only [noop]" })
    // The request answers while setup runs; the session boots in the background.
    expect(session.state).toBe("starting")
    await stateOf(api, session.id, ["idle"])

    const [started, completed] = await setupEvents(api, session.id)
    expect(started).toMatchObject({ type: "tool.started", name: "Setup script", input: { command: expect.stringContaining(".setup-ran") } })
    expect(completed).toMatchObject({ type: "tool.completed", isError: false, result: expect.stringContaining("installed") })
    const [root, workspace, cwd] = readFileSync(join(session.cwd, ".setup-ran"), "utf8").split("|")
    expect(root).toBe((await api.get(`/projects/${project.id}`)).repoPath)
    expect(workspace).toBe(session.cwd)
    expect(cwd).toBe(session.cwd)
    expect(existsSync(join(repo, ".setup-ran"))).toBe(false)
    // The agent's first event comes after setup.
    const history = await api.get(`/sessions/${session.id}/history`)
    const setupDone = history.findIndex((e: any) => e.event.type === "tool.completed")
    const agentStarted = history.findIndex((e: any) => e.event.type === "session.started")
    expect(setupDone).toBeLessThan(agentStarted)
    expect((await api.get(`/tickets/${ticket.id}/workspace`)).setupState).toBe("done")
    const activity = await api.get(`/tickets/${ticket.id}/activity`)
    expect(activity.some((a: any) => a.kind === "workspace.setup")).toBe(true)

    // The next session in the same worktree skips it.
    await api.post(`/sessions/${session.id}/stop`)
    await stateOf(api, session.id, ["closed"])
    const again = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "again [noop]" })
    expect(again.cwd).toBe(session.cwd)
    await stateOf(api, again.id, ["idle"])
    expect(await setupEvents(api, again.id)).toEqual([])
  })

  it("fails the session when the script fails, and runs it again on the next start", async () => {
    const { api, project } = await boot("echo missing toolchain >&2; exit 7")
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Broken setup" })
    const session = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "hello [noop]" })
    await stateOf(api, session.id, ["failed"])
    const [, completed] = await setupEvents(api, session.id)
    expect(completed).toMatchObject({ isError: true, result: expect.stringContaining("missing toolchain") })
    const history = await api.get(`/sessions/${session.id}/history`)
    expect(history.map((e: any) => e.event.type)).not.toContain("session.started")
    expect(history.find((e: any) => e.event.type === "session.error").event.message).toMatch(/setup script exited with code 7/)
    expect((await api.get(`/tickets/${ticket.id}/workspace`)).setupState).toBe("pending")

    // Fixed script: the same worktree is reused (its lock was released) and set up this time.
    await api.patch(`/projects/${project.id}`, { setupCommand: "echo fixed" })
    const retry = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "hello [noop]" })
    expect(retry.cwd).toBe(session.cwd)
    await stateOf(api, retry.id, ["idle"])
    const [, ok] = await setupEvents(api, retry.id)
    expect(ok).toMatchObject({ isError: false, result: expect.stringContaining("fixed") })
  })

  it("stops a session while its setup script runs", async () => {
    const { api, project } = await boot("sleep 30")
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Slow setup" })
    const session = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "hello [noop]" })
    const running = await waitFor(async () => {
      const s = await api.get(`/sessions/${session.id}`)
      return s.statusDetail === "Setup script: sleep 30" ? s : undefined
    })
    expect(running.state).toBe("starting")
    await expect(api.post(`/sessions/${session.id}/prompt`, { text: "hurry" })).rejects.toThrow(/still being set up/)
    await api.post(`/sessions/${session.id}/stop`)
    await stateOf(api, session.id, ["closed"])
    // The worktree is free again: a new session can take it (and retries the setup).
    await api.patch(`/projects/${project.id}`, { setupCommand: null })
    const next = await api.post(`/tickets/${ticket.id}/sessions`, { prompt: "hello [noop]" })
    expect(next.cwd).toBe(session.cwd)
    await stateOf(api, next.id, ["idle"])
  })

  it("prepares workflow worktrees too, failing the run when setup fails", async () => {
    const { api, project } = await boot("exit 3")
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Workflow setup" })
    const run = await api.post(`/tickets/${ticket.id}/start-run`, { workflowId: "quick-fix" })
    const failed = await waitFor(async () => {
      const r = await api.get(`/runs/${run.id}`)
      return r.status === "failed" ? r : undefined
    }, 15_000)
    expect(failed.error).toMatch(/Setup script exited with code 3/)
    expect(failed.steps).toEqual([])
  })
})
