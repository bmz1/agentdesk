import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const procs: Array<ChildProcess> = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const p of procs.splice(0)) if (p.exitCode === null) p.kill("SIGKILL")
  while (cleanups.length) await cleanups.pop()!()
})

/** Run the real daemon entrypoint as a separate OS process. */
const spawnDaemon = async (home: string) => {
  const child = spawn(process.execPath, ["--import", "tsx", join(__dirname, "../src/main.ts")], {
    env: { ...process.env, AGENTDESK_HOME: home, AGENTDESK_PORT: "0", AGENTDESK_DISABLE_JIRA_POLLING: "1", AGENTDESK_TOKEN: "crash-token" },
    cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"]
  })
  procs.push(child)
  let output = ""
  child.stdout!.on("data", (d) => (output += d))
  child.stderr!.on("data", (d) => (output += d))
  const conn = await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`daemon exited: ${output}`)
    const f = join(home, "daemon.json")
    if (!existsSync(f)) return undefined
    // Ignore a stale connection file left behind by a killed daemon.
    const c = JSON.parse(readFileSync(f, "utf8")) as { url: string; pid: number }
    return c.pid === child.pid ? c : undefined
  }, 30_000)
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(conn.url + path, {
      method,
      headers: { authorization: "Bearer crash-token", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${text}`), { status: res.status })
    return text ? JSON.parse(text) : undefined
  }
  return { child, conn, call, output: () => output }
}

describe("crash recovery (real daemon process)", () => {
  it("survives SIGKILL mid-run: sessions and runs become interrupted, resume completes, no duplicate work", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentdesk-crash-"))
    const repo = makeRepo()
    const d1 = await spawnDaemon(home)
    // A second daemon on the same data dir is refused while the first is alive.
    const dup = spawn(process.execPath, ["--import", "tsx", join(__dirname, "../src/main.ts")], {
      env: { ...process.env, AGENTDESK_HOME: home, AGENTDESK_PORT: "0" },
      cwd: join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"]
    })
    let dupOut = ""
    dup.stderr!.on("data", (x) => (dupOut += x))
    const dupCode = await new Promise<number | null>((r) => dup.on("exit", r))
    expect(dupCode).toBe(1)
    expect(dupOut).toContain("already using")

    const project = await d1.call("POST", "/projects", {
      name: "Crash",
      repoPath: repo,
      defaultHarness: "mock",
      permissionMode: "accept_edits",
      testCommand: "true"
    })
    const ticket = await d1.call("POST", "/tickets", { projectId: project.id, title: "Survive [slow]" })
    const run = await d1.call("POST", `/tickets/${ticket.id}/start-run`, { workflowId: "quick-fix" })
    await waitFor(async () => {
      const r = await d1.call("GET", `/runs/${run.id}`)
      return r.steps[0]?.state === "running" && r.steps[0]?.sessionId ? r : undefined
    }, 15_000)
    d1.child.kill("SIGKILL")
    await new Promise((r) => d1.child.on("exit", r))

    const d2 = await spawnDaemon(home)
    const r = await d2.call("GET", `/runs/${run.id}`)
    expect(r.status).toBe("interrupted")
    expect(r.steps[0].state).toBe("interrupted")
    const session = await d2.call("GET", `/sessions/${r.steps[0].sessionId}`)
    expect(session.state).toBe("interrupted")
    expect(await d2.call("GET", "/sessions?active=1")).toEqual([])

    await d2.call("POST", `/runs/${run.id}/resume`)
    const done = await waitFor(async () => {
      const x = await d2.call("GET", `/runs/${run.id}`)
      return ["completed", "failed"].includes(x.status) ? x : undefined
    }, 30_000)
    expect(done.status).toBe("completed")
    expect(done.steps.map((s: any) => `${s.stepId}#${s.attempt}:${s.state}`)).toEqual([
      "implement#1:interrupted",
      "implement#2:completed",
      "test#1:completed"
    ])
    // Exactly one worktree for the run.
    expect(new Set([run.id, done.workspace.runId]).size).toBe(1)
    d2.child.kill("SIGTERM")
    expect(await new Promise((r) => d2.child.on("exit", r))).toBe(0)
    expect(existsSync(join(home, "daemon.json"))).toBe(false)
  }, 90_000)
})

describe("security guardrails", () => {
  it("refuses unrestricted mode without a sandbox and redacts secrets in transcripts and diffs", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const yolo = await api.post("/projects", { name: "Yolo", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "unrestricted" })
    const t1 = await api.post("/tickets", { projectId: yolo.id, title: "Nope" })
    await expect(api.post(`/tickets/${t1.id}/sessions`, {})).rejects.toMatchObject({ status: 400 })

    const safe = await api.post("/projects", { name: "Safe", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "accept_edits" })
    const t2 = await api.post("/tickets", { projectId: safe.id, title: "Leaky" })
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
    const s = await api.post(`/tickets/${t2.id}/sessions`, { prompt: `use token ${secret}` })
    await api.sse(`/sessions/${s.id}/events`, (evs) => evs.some((e) => e.event.type === "turn.completed"))
    const history = JSON.stringify(await api.get(`/sessions/${s.id}/history`))
    expect(history).not.toContain(secret)
    expect(history).toContain("[REDACTED GITHUB TOKEN]")
    // The mock wrote the (unredacted) prompt into a file; the diff preview is redacted.
    const diff = await api.get(`/tickets/${t2.id}/diff`)
    expect(diff.patch).not.toContain(secret)
  })
})
