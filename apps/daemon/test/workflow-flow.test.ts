import { execSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Repo with a bare "origin" so pushes work, plus a fake PR provider that records calls. */
const setup = () => {
  const repo = makeRepo()
  const remote = mkdtempSync(join(tmpdir(), "origin-"))
  execSync("git init -q --bare", { cwd: remote })
  execSync(`git remote add origin ${remote} && git push -q origin main`, { cwd: repo })
  const prs: Array<{ branch: string; title: string; body: string; draft: boolean }> = []
  const provider = {
    id: "github" as const,
    findOpen: (_cwd: string, branch: string) =>
      Effect.succeed(prs.find((p) => p.branch === branch) ? { url: "https://example.test/pr/1", number: 1, existing: true } : undefined),
    create: (i: { branch: string; title: string; body: string; draft: boolean }) =>
      Effect.sync(() => {
        const existing = prs.find((p) => p.branch === i.branch)
        if (!existing) prs.push(i)
        return { url: "https://example.test/pr/1", number: 1, existing: !!existing }
      })
  }
  return { repo, remote, prs, provider }
}

const runOf = (api: any, id: string) => api.get(`/runs/${id}`)
const waitStatus = (api: any, id: string, statuses: Array<string>) =>
  waitFor(async () => {
    const r = await runOf(api, id)
    return statuses.includes(r.status) ? r : undefined
  }, 20_000)
const pendingFor = async (api: any, runId: string) => (await api.get("/approvals?pending=1")).filter((a: any) => a.runId === runId)

describe("workflow engine", () => {
  it("plan → approve → implement → test → review → approved draft PR", async () => {
    const { repo, remote, prs, provider } = setup()
    const { daemon, api } = await startTestDaemon({ workflows: { prProvider: () => provider } })
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", {
      name: "Flow",
      repoPath: repo,
      gitProvider: "github",
      defaultHarness: "mock",
      permissionMode: "accept_edits",
      testCommand: "test -f AGENTDESK_NOTES.md"
    })
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Add notes" })
    const workflows = await api.get("/workflows")
    expect(workflows.map((w: any) => w.id)).toEqual(expect.arrayContaining(["plan-implement-test-pr", "quick-fix"]))

    const run = await api.post(`/tickets/${ticket.id}/start-run`, { harness: "mock" })
    expect(run.workflowVersion).toBe(1)
    await expect(api.post(`/tickets/${ticket.id}/start-run`, {})).rejects.toMatchObject({ status: 400 })

    let r = await waitStatus(api, run.id, ["waiting_for_approval"])
    expect(r.activeStepId).toBe("approve_plan")
    expect(r.artifacts.find((a: any) => a.name === "artifacts/plan.md").content).toContain("Working on it")
    const [planApproval] = await pendingFor(api, run.id)
    expect(planApproval).toMatchObject({ kind: "workflow_step", title: "Approve plan" })
    expect((await api.get(`/tickets/${ticket.id}`)).latestRun.needsInput).toBe(true)
    await api.post(`/approvals/${planApproval.id}/decision`, { decision: "allow" })

    r = await waitStatus(api, run.id, ["waiting_for_approval", "failed"])
    expect(r.status).toBe("waiting_for_approval")
    expect(r.activeStepId).toBe("draft_pr")
    expect(r.steps.map((s: any) => `${s.stepId}:${s.state}`)).toEqual([
      "plan:completed",
      "approve_plan:completed",
      "implement:completed",
      "test:completed",
      "review:completed",
      "draft_pr:waiting_for_approval"
    ])
    expect(r.artifacts.some((a: any) => a.type === "check" && a.content.includes("[exit 0"))).toBe(true)
    // Each agent step ran in its own session in the run's worktree.
    expect(new Set(r.steps.filter((s: any) => s.kind === "agent").map((s: any) => s.sessionId)).size).toBe(3)
    expect(prs).toHaveLength(0)

    const [prApproval] = await pendingFor(api, run.id)
    expect(prApproval.kind).toBe("pull_request")
    expect(prApproval.details.files.map((f: any) => f.path)).toContain("AGENTDESK_NOTES.md")
    await api.post(`/approvals/${prApproval.id}/decision`, { decision: "allow" })

    r = await waitStatus(api, run.id, ["completed", "failed"])
    expect(r.status).toBe("completed")
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ draft: true, title: "FLOW-1: Add notes" })
    expect(prs[0]!.body).toContain("## Plan")
    expect(r.artifacts.find((a: any) => a.type === "pull_request").url).toBe("https://example.test/pr/1")
    // Branch was committed and pushed; main untouched (no auto-merge).
    const branches = execSync("git branch --list", { cwd: remote }).toString()
    expect(branches).toContain(r.workspace.branch)
    expect(execSync("git log --oneline main", { cwd: remote }).toString().trim().split("\n")).toHaveLength(1)
    expect((await api.get(`/tickets/${ticket.id}`)).status).toBe("in_review")
    const activity = await api.get(`/tickets/${ticket.id}/activity`)
    expect(activity.some((a: any) => a.kind === "pr.created")).toBe(true)
  })

  it("retries implementation with failure context, bounded by maxAttempts", async () => {
    const { repo } = setup()
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const project = await api.post("/projects", {
      name: "Retry",
      repoPath: repo,
      defaultHarness: "mock",
      permissionMode: "accept_edits",
      testCommand: "echo boom >&2; exit 3"
    })
    const ticket = await api.post("/tickets", { projectId: project.id, title: "Always fails" })
    const run = await api.post(`/tickets/${ticket.id}/start-run`, { workflowId: "quick-fix" })
    const r = await waitStatus(api, run.id, ["failed", "completed"])
    expect(r.status).toBe("failed")
    expect(r.steps.map((s: any) => `${s.stepId}#${s.attempt}:${s.state}`)).toEqual([
      "implement#1:completed",
      "test#1:failed",
      "implement#2:completed",
      "test#2:failed"
    ])
    expect(r.error).toContain('"test" failed after 2 attempt')
    // The retry prompt carried the failing output to the agent.
    const retrySession = r.steps[2].sessionId
    const history = await api.get(`/sessions/${retrySession}/history`)
    expect(history[0].event.text).toContain("exited with code 3")
    expect(history[0].event.text).toContain("boom")

    // User retry re-runs the failed step once more.
    await api.patch(`/projects/${project.id}`, { testCommand: "true" })
    await api.post(`/runs/${run.id}/retry`)
    const r2 = await waitStatus(api, run.id, ["completed", "failed"])
    expect(r2.status).toBe("completed")
  })

  it("keeps approval gates durable across daemon restarts and supports cancel", async () => {
    const { repo } = setup()
    const first = await startTestDaemon()
    const project = await first.api.post("/projects", {
      name: "Durable",
      repoPath: repo,
      defaultHarness: "mock",
      permissionMode: "accept_edits"
    })
    const ticket = await first.api.post("/tickets", { projectId: project.id, title: "Gate" })
    const run = await first.api.post(`/tickets/${ticket.id}/start-run`, { harness: "mock" })
    await waitStatus(first.api, run.id, ["waiting_for_approval"])
    await first.daemon.stop()

    const second = await startTestDaemon({}, first.dataDir)
    cleanups.push(second.daemon.stop)
    expect((await runOf(second.api, run.id)).status).toBe("waiting_for_approval")
    const [approval] = await pendingFor(second.api, run.id)
    await second.api.post(`/approvals/${approval.id}/decision`, { decision: "deny", note: "Too broad, split it" })
    // Rejection re-plans (approve_plan retries plan) and waits again with the feedback.
    const r = await waitFor(async () => {
      const x = await runOf(second.api, run.id)
      return x.steps.length >= 4 && x.status === "waiting_for_approval" ? x : undefined
    })
    expect(r.steps.map((s: any) => `${s.stepId}#${s.attempt}:${s.state}`)).toEqual([
      "plan#1:completed",
      "approve_plan#1:failed",
      "plan#2:completed",
      "approve_plan#2:waiting_for_approval"
    ])
    const replan = await second.api.get(`/sessions/${r.steps[2].sessionId}/history`)
    expect(replan[0].event.text).toContain("Too broad, split it")

    await second.api.post(`/runs/${run.id}/cancel`)
    const c = await runOf(second.api, run.id)
    expect(c.status).toBe("cancelled")
    expect(await pendingFor(second.api, run.id)).toHaveLength(0)
    await expect(second.api.post(`/runs/${run.id}/cancel`)).rejects.toMatchObject({ status: 400 })
  })
})
