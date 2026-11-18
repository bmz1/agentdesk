import { afterEach, describe, expect, it } from "@effect/vitest"
import type { RunPolicy } from "@agentdesk/harness-core"
import { makeMockAdapter } from "@agentdesk/harness-core"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe("harness launch defaults", () => {
  it("persists independent profiles and a default harness across daemon restarts", async () => {
    const first = await startTestDaemon()
    cleanups.push(first.daemon.stop)
    expect((await first.api.get("/settings/harnesses")).defaultHarness).toBe("claude")
    await first.api.patch("/settings/harnesses", {
      defaultHarness: "mock",
      harnesses: { mock: { model: " demo-model ", permissionMode: "accept_edits", instructions: " Run tests. " } }
    })
    const value = await first.api.patch("/settings/harnesses", {
      harnesses: { codex: { model: "codex-model", permissionMode: "plan", instructions: "Plan first." } }
    })
    expect(value.harnesses.mock).toEqual({ model: "demo-model", permissionMode: "accept_edits", instructions: "Run tests." })
    expect(value.harnesses.codex.permissionMode).toBe("plan")
    const p = await first.api.post("/projects", { name: "Defaults", repoPath: makeRepo() })
    expect(p).toMatchObject({ defaultHarness: "mock", inheritHarnessPermissions: true })
    const explicit = await first.api.patch(`/projects/${p.id}`, { permissionMode: "plan" })
    expect(explicit).toMatchObject({ permissionMode: "plan", inheritHarnessPermissions: false })
    await first.daemon.stop()
    cleanups.pop()
    const second = await startTestDaemon({}, first.dataDir)
    cleanups.push(second.daemon.stop)
    expect(await second.api.get("/settings/harnesses")).toEqual(value)
  })

  it("rejects invalid profiles and refuses unrestricted defaults without a sandbox", async () => {
    const { api, daemon } = await startTestDaemon()
    cleanups.push(daemon.stop)
    await expect(api.patch("/settings/harnesses", { defaultHarness: "unknown" })).rejects.toMatchObject({ status: 400 })
    await expect(
      api.patch("/settings/harnesses", { harnesses: { mock: { model: null, permissionMode: "unrestricted", instructions: "" } } })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      api.patch("/settings/harnesses", { harnesses: { opencode: { model: "missing-provider", permissionMode: "ask", instructions: "" } } })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      api.patch("/settings/harnesses", { harnesses: { codex: { model: "x".repeat(501), permissionMode: "ask", instructions: "" } } })
    ).rejects.toMatchObject({ status: 400 })
    expect((await api.get("/settings/harnesses")).harnesses.mock.permissionMode).toBe("ask")
  })

  it("applies profiles to direct, resumed and workflow sessions while preserving overrides", async () => {
    const policies: Array<RunPolicy> = []
    const mock = makeMockAdapter({ delayMs: 0 })
    const { api, daemon } = await startTestDaemon({
      adapters: [
        {
          ...mock,
          start: (input) => {
            policies.push(input.policy)
            return mock.start(input)
          },
          resume: (input) => {
            policies.push(input.policy)
            return mock.resume!(input)
          }
        }
      ]
    })
    cleanups.push(daemon.stop)
    await api.patch("/settings/harnesses", {
      defaultHarness: "mock",
      harnesses: { mock: { model: "default-model", permissionMode: "accept_edits", instructions: "Use tests." } }
    })
    const p = await api.post("/projects", { name: "Launch", repoPath: makeRepo() })
    const t = await api.post("/tickets", { projectId: p.id, title: "Defaults [noop]" })
    const s = await api.post(`/tickets/${t.id}/sessions`)
    await waitFor(async () => (await api.get(`/sessions/${s.id}`)).state === "idle" || undefined)
    expect(policies[0]).toMatchObject({ model: "default-model", permissionMode: "accept_edits", appendSystemPrompt: "Use tests." })
    await api.post(`/sessions/${s.id}/stop`)
    await waitFor(async () => (await api.get(`/sessions/${s.id}`)).state === "closed" || undefined)
    await api.patch(`/tickets/${t.id}`, { model: "ticket-model" })
    await api.patch(`/projects/${p.id}`, { permissionMode: "plan" })
    await api.post(`/sessions/${s.id}/prompt`, { text: "Continue [noop]" })
    await waitFor(async () => (await api.get(`/sessions/${s.id}`)).state === "idle" || undefined)
    expect(policies[1]).toMatchObject({ model: "ticket-model", permissionMode: "plan", appendSystemPrompt: "Use tests." })
    await api.post(`/sessions/${s.id}/stop`)
    await waitFor(async () => (await api.get(`/sessions/${s.id}`)).state === "closed" || undefined)
    await api.patch(`/projects/${p.id}`, { inheritHarnessPermissions: true })
    await api.post("/workflows", {
      yaml: "id: defaults-test\nversion: 1\nname: Defaults\nsteps:\n  - id: agent\n    kind: agent\n    instructions: Verify defaults [noop]\n"
    })
    const run = await api.post(`/tickets/${t.id}/start-run`, { workflowId: "defaults-test" })
    await waitFor(async () => (await api.get(`/runs/${run.id}`)).status === "completed" || undefined)
    expect(policies[2]).toMatchObject({ model: "ticket-model", permissionMode: "accept_edits", appendSystemPrompt: "Use tests." })
  })
})
