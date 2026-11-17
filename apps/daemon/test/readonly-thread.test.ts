import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { editTargets, inferCreatedWorktree, readOnlyPolicy, touchesMainCheckout } from "../src/services/readonly-threads"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const turns = async (api: any, sessionId: string, n: number) =>
  waitFor(async () => {
    const h = await api.get(`/sessions/${sessionId}/history`)
    return h.filter((e: any) => e.event.type === "turn.completed").length >= n ? h : undefined
  })

describe("read-only thread helpers", () => {
  const approval = (toolName: string, details: unknown) =>
    ({ type: "approval.requested", approvalId: "a", toolName, summary: "", details }) as const

  it("extracts edit targets per harness shape", () => {
    expect(editTargets(approval("Write", { input: { file_path: "/r/a.ts" } }), "/r")).toEqual({ edit: true, paths: ["/r/a.ts"] })
    expect(editTargets(approval("Write", { file_path: "a.ts" }), "/r").paths).toEqual(["/r/a.ts"])
    expect(editTargets(approval("edit", { patterns: ["src/x.ts"] }), "/r").paths).toEqual(["/r/src/x.ts"])
    expect(editTargets(approval("Edit", { input: {} }), "/r")).toEqual({ edit: true, paths: [] })
    expect(editTargets(approval("Bash", { input: { command: "ls" } }), "/r").edit).toBe(false)
  })

  it("treats nested agent worktrees as outside the main checkout", () => {
    expect(touchesMainCheckout("/r/src/a.ts", "/r", [])).toBe(true)
    expect(touchesMainCheckout("/r/.claude/worktrees/x/a.ts", "/r", ["/r/.claude/worktrees/x"])).toBe(false)
    expect(touchesMainCheckout("/elsewhere/a.ts", "/r", [])).toBe(false)
  })

  it("infers the created worktree from mentions, or a lone new one", () => {
    const a = { path: "/w/feat-login", branch: "feat/login", head: null }
    const b = { path: "/w/other", branch: "other", head: null }
    const base = { hasSnapshot: true, otherReadOnlySessions: 0 }
    expect(inferCreatedWorktree({ ...base, candidates: [a, b], actions: "git worktree add ../feat-login -b feat/login" })).toBe(a)
    expect(inferCreatedWorktree({ ...base, candidates: [a, b], actions: "" })).toBeUndefined()
    expect(inferCreatedWorktree({ ...base, candidates: [b], actions: "" })).toBe(b)
    expect(inferCreatedWorktree({ ...base, candidates: [b], actions: "", otherReadOnlySessions: 1 })).toBeUndefined()
    expect(inferCreatedWorktree({ ...base, candidates: [b], actions: "", hasSnapshot: false })).toBeUndefined()
  })

  it("forces approvals and appends the read-only instructions", () => {
    const p = readOnlyPolicy({ permissionMode: "accept_edits", appendSystemPrompt: "Be terse." }, "/r")
    expect(p.permissionMode).toBe("ask")
    expect(p.appendSystemPrompt).toMatch(/^Be terse\.\n\n.*read-only/s)
  })
})

describe("read-only threads", () => {
  it("stay off the board, refuse edits in the main checkout and adopt the worktree the agent creates", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    const p = await api.post("/projects", { name: "Threads", key: "THR", repoPath: repo, defaultHarness: "mock", permissionMode: "accept_edits" })
    const t = await api.post("/tickets", { projectId: p.id, title: "Brainstorm login", tracked: false, workspaceMode: "readonly" })
    expect(t).toMatchObject({ tracked: false, workspaceMode: "readonly" })
    expect((await api.get(`/tickets?projectId=${p.id}&tracked=1`)).map((x: any) => x.id)).not.toContain(t.id)
    expect((await api.get(`/tickets?projectId=${p.id}&tracked=0`)).map((x: any) => x.id)).toContain(t.id)

    // Runs in the main checkout; the attempted write there is refused without asking the user.
    const s = await api.post(`/tickets/${t.id}/sessions`, { prompt: "How should login work? [write:notes.md]" })
    expect(realpathSync(s.cwd)).toBe(realpathSync(repo))
    const first = await turns(api, s.id, 1)
    expect(first[0].event).toMatchObject({ type: "user.prompt", text: "How should login work? [write:notes.md]" })
    expect(first.some((e: any) => e.event.type === "session.status" && e.event.state === "edit_blocked")).toBe(true)
    expect(first.some((e: any) => e.event.type === "approval.requested")).toBe(false)
    expect(existsSync(join(repo, "notes.md"))).toBe(false)
    expect(await api.get(`/tickets/${t.id}/workspace`)).toBeNull()

    // The agent creates a worktree (simulated here); the next turn end adopts it.
    const wt = join(mkdtempSync(join(tmpdir(), "agent-wt-")), "feat-login")
    execSync(`git worktree add -q -b feat/login ${wt}`, { cwd: repo })
    await api.post(`/sessions/${s.id}/prompt`, { text: "Created the worktree feat-login [noop]" })
    const second = await turns(api, s.id, 2)
    expect(second.some((e: any) => e.event.type === "session.status" && e.event.state === "worktree_adopted")).toBe(true)
    const ws = await api.get(`/tickets/${t.id}/workspace`)
    expect(ws).toMatchObject({ branch: "feat/login", path: realpathSync(wt) })

    // Later sessions start in the adopted worktree with the project's normal permissions.
    await api.post(`/sessions/${s.id}/stop`)
    await waitFor(async () => ((await api.get(`/sessions/${s.id}`)).state === "closed" ? true : undefined))
    const next = await api.post(`/tickets/${t.id}/sessions`, { prompt: "Implement it [noop]" })
    expect(realpathSync(next.cwd)).toBe(realpathSync(wt))

    // Promoting the thread puts it on the board.
    await api.patch(`/tickets/${t.id}`, { tracked: true })
    expect((await api.get(`/tickets?projectId=${p.id}&tracked=1`)).map((x: any) => x.id)).toContain(t.id)
  })
})
