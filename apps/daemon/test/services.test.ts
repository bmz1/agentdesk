import { describe, expect, it } from "@effect/vitest"
import { agentSessions } from "@agentdesk/db"
import { Duration, Effect, Fiber, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { makeFakeJira } from "../../../packages/jira/test/fake-jira"
import { toHttpError } from "../src/http/respond"
import { EventLog } from "../src/services/event-log"
import { Database } from "../src/services/database"
import { TaskSync } from "../src/services/task-sync"
import { Maintenance } from "../src/services/maintenance"
import { Projects } from "../src/services/projects"
import { Sessions } from "../src/services/sessions"
import { Tickets } from "../src/services/tickets"
import { Workflows } from "../src/services/workflows"
import { makeRecordingTracer, makeRepo, TestApp } from "./support"

/** Poll a run until it reaches a terminal state. */
const awaitRun = (id: string) =>
  Workflows.use((w) => w.get(id)).pipe(
    Effect.repeat({ until: (r) => ["completed", "failed", "cancelled"].includes(r.status), schedule: Schedule.spaced("25 millis") })
  )

/** Let real async I/O (fake fetch, SQLite callbacks) settle between virtual-time steps. */
const settle = Effect.promise(() => new Promise((r) => setTimeout(r, 20)))

describe("typed errors", () => {
  it.effect("services fail with tagged, schema-backed errors that map exhaustively to HTTP", () =>
    Effect.gen(function* () {
      const notFound = yield* Effect.flip(Projects.use((p) => p.get("missing")))
      expect(notFound).toMatchObject({ _tag: "NotFound", entity: "project", id: "missing" })
      expect(toHttpError(notFound).status).toBe(404)

      const badRepo = yield* Effect.flip(Projects.use((p) => p.create({ name: "x", repoPath: "/does/not/exist" })))
      expect(badRepo._tag).toBe("BadRequest")
      expect(toHttpError(badRepo).status).toBe(400)

      const invalid = yield* Effect.flip(Workflows.use((w) => w.save("id: x\nversion: 1\nname: x\nsteps: []")))
      expect(invalid._tag).toBe("WorkflowValidationError")
      expect(toHttpError(invalid)).toMatchObject({ status: 400, error: "WorkflowValidationError" })

      const prompt = yield* Effect.flip(Sessions.use((s) => s.prompt("nope", "hi")))
      expect(prompt._tag).toBe("NotFound")

      // Unrestricted mode without a sandbox is a typed BadRequest, not a thrown exception.
      const p = yield* Projects.use((x) => x.create({ name: "Yolo", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "unrestricted" }))
      const t = yield* Tickets.use((x) => x.create({ projectId: p.id, title: "t" }))
      const yolo = yield* Effect.flip(Sessions.use((s) => s.startForTicket(t.id, {})))
      expect(yolo).toMatchObject({ _tag: "BadRequest" })
      expect(yolo.message).toContain("sandbox")
    }).pipe(Effect.provide(TestApp()))
  )
})

describe("time-dependent behaviour on the Effect Clock (TestClock)", () => {
  it.effect("the daily maintenance job prunes transcripts of sessions ended more than retentionDays ago", () =>
    Effect.gen(function* () {
      const p = yield* Projects.use((x) => x.create({ name: "Ret", repoPath: makeRepo() }))
      const t = yield* Tickets.use((x) => x.create({ projectId: p.id, title: "Old work" }))
      const { use } = yield* Database
      const at = new Date(0).toISOString() // TestClock starts at the epoch
      yield* use((db) =>
        db
          .insert(agentSessions)
          .values({ id: "s1", ticketId: t.id, harness: "mock", state: "closed", cwd: "/", createdAt: at, updatedAt: at })
          .run()
      )
      yield* EventLog.use((e) => e.append("s1", { type: "user.prompt", text: "hello" }))

      // Within retention (one daily run already happened at t=1min): nothing pruned.
      yield* TestClock.adjust(Duration.days(29))
      expect(yield* EventLog.use((e) => e.history("s1"))).toHaveLength(1)
      // Past retention: the scheduled daily job (Schedule.spaced(24h) on the Effect Clock) prunes it.
      yield* TestClock.adjust(Duration.days(2))
      expect(yield* EventLog.use((e) => e.history("s1"))).toEqual([])
      expect(yield* Maintenance.use((m) => m.pruneTranscripts)).toBe(0) // idempotent
    }).pipe(Effect.provide(TestApp({ retentionDays: 30 })))
  )

  it.effect("source pollers back off exponentially after failures", () => {
    const fake = makeFakeJira({ deployment: "cloud", issues: [] })
    fake.state.failAuth = true
    return Effect.gen(function* () {
      yield* TaskSync.use((t) =>
        t.create({
          provider: "jira",
          name: "c",
          token: "t",
          pollIntervalSec: 60,
          settings: { deployment: "cloud", baseUrl: "https://x.atlassian.net", principal: "me@x", jql: "project = X" }
        })
      )
      yield* settle
      expect(fake.state.calls).toHaveLength(1) // first poll runs immediately and fails
      // 1 failure → wait 2 × 60s; 2 failures → 4 × 60s.
      yield* TestClock.adjust(Duration.seconds(119))
      yield* settle
      expect(fake.state.calls).toHaveLength(1)
      yield* TestClock.adjust(Duration.seconds(1))
      yield* settle
      expect(fake.state.calls).toHaveLength(2)
      yield* TestClock.adjust(Duration.seconds(239))
      yield* settle
      expect(fake.state.calls).toHaveLength(2)
      yield* TestClock.adjust(Duration.seconds(1))
      yield* settle
      expect(fake.state.calls).toHaveLength(3)
    }).pipe(Effect.provide(TestApp({ enableSourcePolling: true }, { sources: { fetch: fake.fetch } })))
  })
})

describe("workflow scheduling (FiberMap + Semaphores)", () => {
  it.live("admits runs FIFO and never exceeds the per-project cap", () =>
    Effect.gen(function* () {
      const p = yield* Projects.use((x) =>
        x.create({ name: "Cap", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "accept_edits", testCommand: "sleep 0.3" })
      )
      const runs: Array<string> = []
      for (const title of ["a", "b", "c"]) {
        const t = yield* Tickets.use((x) => x.create({ projectId: p.id, title }))
        runs.push((yield* Workflows.use((w) => w.start(t.id, { workflowId: "quick-fix" }))).id)
      }
      let maxActive = 0
      const sampler = yield* Workflows.use((w) =>
        Effect.sync(() => {
          maxActive = Math.max(maxActive, w.activeCount())
        })
      ).pipe(Effect.repeat(Schedule.spaced("10 millis")), Effect.forkChild)
      const details = yield* Effect.forEach(runs, (id) => awaitRun(id))
      yield* Fiber.interrupt(sampler)
      expect(details.map((r) => r.status)).toEqual(["completed", "completed", "completed"])
      expect(maxActive).toBe(1)
      // FIFO: each run started after the previous one finished.
      for (let i = 1; i < details.length; i++) {
        expect(details[i]!.startedAt! >= details[i - 1]!.finishedAt!).toBe(true)
      }
    }).pipe(Effect.provide(TestApp({ maxRunsPerProject: 1, maxConcurrentRuns: 3 }))),
    30_000
  )
})

describe("tracing", () => {
  it.live("a workflow run produces a meaningful span tree", () => {
    const { tracer, recorded } = makeRecordingTracer()
    return Effect.gen(function* () {
      const p = yield* Projects.use((x) =>
        x.create({ name: "Trace", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "accept_edits", testCommand: "true" })
      )
      const t = yield* Tickets.use((x) => x.create({ projectId: p.id, title: "Traced" }))
      const run = yield* Workflows.use((w) => w.start(t.id, { workflowId: "quick-fix" }))
      yield* awaitRun(run.id)

      const spans = recorded()
      const names = new Set(spans.map((s) => s.name))
      for (const name of [
        "Workflows.start",
        "Workflow.schedule",
        "Workflow.run",
        "Workflow.step",
        "Workflow.agentStep",
        "Workflow.commandStep",
        "Sessions.start",
        "Sessions.launch",
        "Harness.start",
        "AgentSession",
        "Sessions.awaitTurn",
        "Workspaces.allocate"
      ]) {
        expect(names, `missing span ${name}`).toContain(name)
      }
      const steps = spans.filter((s) => s.name === "Workflow.step")
      expect(steps.map((s) => s.attributes.stepId)).toEqual(["implement", "test"])
      expect(steps.every((s) => s.parent === "Workflow.run" && s.attributes.runId === run.id)).toBe(true)
      expect(steps.map((s) => s.attributes.outcome)).toEqual(["completed", "completed"])
      const command = spans.find((s) => s.name === "Workflow.commandStep")!
      expect(command).toMatchObject({ parent: "Workflow.step", attributes: { command: "true", exitCode: 0 } })
      expect(spans.find((s) => s.name === "Sessions.launch")!.attributes).toMatchObject({ harness: "mock", ticketId: t.id })
    }).pipe(Effect.provide(TestApp()), Effect.withTracer(tracer))
  }, 30_000)
})
