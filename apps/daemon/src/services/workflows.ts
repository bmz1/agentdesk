import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type {
  Artifact,
  HarnessId,
  StartRunBody,
  StepRun,
  StepState,
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunDetail
} from "@agentdesk/contracts"
import { approvals as approvalsTable, artifacts, stepRuns, workflowDefinitions, workflowRuns } from "@agentdesk/db"
import * as Git from "@agentdesk/git"
import { runCommand } from "@agentdesk/harness-core"
import { compileWorkflow, type ExecutionPlan, nextAction, type PlanStep } from "@agentdesk/workflows"
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Duration, Effect, Fiber, Layer, Option } from "effect"
import { DaemonConfig } from "../config"
import { BadRequest, Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { Approvals, toApproval } from "./approvals"
import { Database } from "./database"
import { Notices } from "./notices"
import { Projects } from "./projects"
import { buildTicketPrompt, Sessions } from "./sessions"
import { Tickets } from "./tickets"
import { Workspaces } from "./workspaces"

export const DEFAULT_WORKFLOW_ID = "plan-implement-test-pr"
const ACTIVE_RUN_STATES = ["queued", "preparing", "running", "retrying"]
const TERMINAL = ["completed", "failed", "cancelled"]

type RunRow = typeof workflowRuns.$inferSelect
type StepRow = typeof stepRuns.$inferSelect

interface StepOutcome {
  readonly state: StepState
  readonly output?: string | null
  readonly error?: string | null
}

export interface WorkflowsOptions {
  /** Override PR creation (tests). */
  readonly prProvider?: (provider: string) => Git.PullRequestProvider | undefined
}

export interface WorkflowsShape {
  readonly definitions: Effect.Effect<ReadonlyArray<WorkflowDefinitionSummary>, DbError>
  readonly definition: (id: string) => Effect.Effect<WorkflowDefinitionSummary & { versions: ReadonlyArray<number> }, NotFound | DbError>
  readonly save: (yaml: string) => Effect.Effect<WorkflowDefinitionSummary, BadRequest | Conflict | DbError>
  readonly validate: (yaml: string) => Effect.Effect<{ ok: boolean; errors: ReadonlyArray<string> }>
  readonly start: (ticketId: string, body: StartRunBody) => Effect.Effect<WorkflowRun, NotFound | BadRequest | DbError>
  readonly get: (id: string) => Effect.Effect<WorkflowRunDetail, NotFound | DbError>
  readonly list: (filter: { ticketId?: string; status?: string }) => Effect.Effect<ReadonlyArray<WorkflowRun>, DbError>
  readonly cancel: (id: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
  readonly resume: (id: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
  /** Re-run the last failed step as a new attempt. */
  readonly retry: (id: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
  readonly resolveApproval: (
    approvalId: string,
    decision: "allow" | "deny",
    actor: string,
    note?: string
  ) => Effect.Effect<void, NotFound | Conflict | DbError>
  readonly artifact: (id: string) => Effect.Effect<Artifact, NotFound | DbError>
  readonly activeCount: () => number
  readonly reconcile: Effect.Effect<number, DbError>
}

export class Workflows extends Context.Service<Workflows, WorkflowsShape>()("agentdesk/Workflows") {}

const toRun = (r: RunRow): WorkflowRun => ({
  id: r.id,
  ticketId: r.ticketId,
  workflowId: r.workflowId,
  workflowVersion: r.workflowVersion,
  status: r.status as WorkflowRun["status"],
  activeStepId: r.activeStepId,
  workspaceId: r.workspaceId,
  error: r.error,
  createdAt: r.createdAt,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt
})

const toStep = (r: StepRow): StepRun => ({
  id: r.id,
  runId: r.runId,
  stepId: r.stepId,
  stepIndex: r.stepIndex,
  kind: r.kind,
  attempt: r.attempt,
  state: r.state as StepState,
  sessionId: r.sessionId,
  idempotencyKey: r.idempotencyKey,
  output: r.output,
  error: r.error,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt
})

const toArtifact = (r: typeof artifacts.$inferSelect): Artifact => ({ ...r })

const errorMessage = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e)

const tail = (s: string, n = 20_000) => (s.length > n ? "…\n" + s.slice(-n) : s)

export const WorkflowsLive = (options: WorkflowsOptions = {}) =>
  Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const config = yield* DaemonConfig
      const { use, tx } = yield* Database
      const notices = yield* Notices
      const activity = yield* Activity
      const approvals = yield* Approvals
      const sessions = yield* Sessions
      const tickets = yield* Tickets
      const projects = yield* Projects
      const workspaces = yield* Workspaces
      const layerScope = yield* Effect.scope
      const executors = new Map<string, Fiber.Fiber<unknown, unknown>>()
      const prProvider = options.prProvider ?? Git.providerFor

      // ---- definitions --------------------------------------------------------------
      const resolvePrompt = (p: string) => {
        const full = resolve(config.promptsDir, p)
        if (!full.startsWith(resolve(config.promptsDir))) return undefined
        return existsSync(full) ? readFileSync(full, "utf8") : undefined
      }
      const compile = (yaml: string) => compileWorkflow(yaml, { resolvePrompt })

      const summary = (r: typeof workflowDefinitions.$inferSelect): WorkflowDefinitionSummary => {
        const plan = r.plan as ExecutionPlan
        return {
          id: r.id,
          version: r.version,
          name: r.name,
          yaml: r.yaml,
          steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, name: s.name })),
          createdAt: r.createdAt
        }
      }

      const insertDefinition = (yaml: string, plan: ExecutionPlan) =>
        Effect.gen(function* () {
          const existing = yield* use((db) =>
            db
              .select()
              .from(workflowDefinitions)
              .where(and(eq(workflowDefinitions.id, plan.id), eq(workflowDefinitions.version, plan.version)))
              .get()
          )
          if (existing) {
            if (existing.yaml.trim() === yaml.trim()) return summary(existing)
            return yield* new Conflict({
              message: `${plan.id} v${plan.version} already exists and versions are immutable; bump "version" to save changes`
            })
          }
          const row = { id: plan.id, version: plan.version, name: plan.name, yaml, plan, createdAt: nowIso() }
          yield* use((db) => db.insert(workflowDefinitions).values(row).run())
          yield* notices.publish({ topic: "workflows" })
          return summary(row)
        })

      const loadPlan = (id: string, version: number) =>
        use((db) =>
          db
            .select()
            .from(workflowDefinitions)
            .where(and(eq(workflowDefinitions.id, id), eq(workflowDefinitions.version, version)))
            .get()
        ).pipe(
          Effect.flatMap((r) =>
            r ? Effect.succeed(r.plan as ExecutionPlan) : Effect.fail(new NotFound({ entity: "workflow", id: `${id}@${version}` }))
          )
        )

      const latestDefinition = (id: string) =>
        use((db) =>
          db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, id)).orderBy(desc(workflowDefinitions.version)).all()
        ).pipe(
          Effect.flatMap((rows) =>
            rows[0]
              ? Effect.succeed({ ...summary(rows[0]), versions: rows.map((r) => r.version) })
              : Effect.fail(new NotFound({ entity: "workflow", id }))
          )
        )

      // Load bundled/user workflow files (immutable versions; changed content needs a version bump).
      if (existsSync(config.workflowsDir)) {
        for (const f of readdirSync(config.workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
          const yaml = readFileSync(join(config.workflowsDir, f), "utf8")
          yield* compile(yaml).pipe(
            Effect.flatMap((plan) => insertDefinition(yaml, plan)),
            Effect.catch((e) => Effect.logWarning(`Skipping workflow ${f}: ${e.message}`))
          )
        }
      }

      // ---- run state helpers --------------------------------------------------------
      const getRunRow = (id: string) =>
        use((db) => db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).get()).pipe(
          Effect.flatMap((r) => (r ? Effect.succeed(r) : Effect.fail(new NotFound({ entity: "run", id }))))
        )
      const stepsOf = (runId: string) =>
        use((db) => db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(sql`rowid`).all())

      const setRun = (id: string, patch: Partial<RunRow>) =>
        Effect.gen(function* () {
          const row = yield* use((db) => db.update(workflowRuns).set(patch).where(eq(workflowRuns.id, id)).returning().get())
          if (row) yield* notices.publish({ topic: "runs", runId: id, ticketId: row.ticketId })
          return row
        })
      const setStep = (id: string, patch: Partial<StepRow>) =>
        use((db) => db.update(stepRuns).set(patch).where(eq(stepRuns.id, id)).returning().get())

      const saveArtifact = (input: {
        runId: string
        stepRunId: string | null
        type: string
        name: string
        content?: string | null
        url?: string | null
        gitCommit?: string | null
      }) =>
        Effect.gen(function* () {
          let path: string | null = null
          let sha256: string | null = null
          if (input.content != null) {
            path = join(config.artifactsDir, input.runId, input.name.replace(/\.\.+/g, "_"))
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, input.content)
            sha256 = createHash("sha256").update(input.content).digest("hex")
          }
          const row = {
            id: newId(),
            runId: input.runId,
            stepRunId: input.stepRunId,
            type: input.type,
            name: input.name,
            path,
            content: input.content ?? null,
            sha256,
            gitCommit: input.gitCommit ?? null,
            url: input.url ?? null,
            createdAt: nowIso()
          }
          yield* use((db) => db.insert(artifacts).values(row).run())
          return row
        })

      const latestArtifact = (runId: string, name: string) =>
        use((db) =>
          db.select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.name, name))).orderBy(desc(artifacts.createdAt)).get()
        )

      // ---- step execution -----------------------------------------------------------
      const executeStep = (run: RunRow, plan: ExecutionPlan, step: PlanStep, attempt: number, retryOf: number | undefined) =>
        Effect.gen(function* () {
          const stepRunId = newId()
          // Durable claim: the unique idempotency key makes double-execution of an attempt impossible.
          yield* use((db) =>
            db
              .insert(stepRuns)
              .values({
                id: stepRunId,
                runId: run.id,
                stepId: step.id,
                stepIndex: step.index,
                kind: step.kind,
                attempt,
                state: "running",
                sessionId: null,
                idempotencyKey: `${run.id}:${step.id}:${attempt}`,
                input: retryOf !== undefined ? { retryOf: plan.steps[retryOf]?.id } : null,
                output: null,
                error: null,
                startedAt: nowIso(),
                finishedAt: null
              })
              .run()
          )
          yield* setRun(run.id, { activeStepId: step.id, status: retryOf !== undefined ? "retrying" : "running" })
          yield* activity.record({
            kind: "step.started",
            message: `Step "${step.name}" started${attempt > 1 ? ` (attempt ${attempt})` : ""}`,
            ticketId: run.ticketId,
            runId: run.id
          })
          const outcome = yield* runStepBody(run, plan, step, stepRunId, retryOf).pipe(
            Effect.catch((e) => Effect.succeed<StepOutcome>({ state: "failed", error: errorMessage(e) }))
          )
          yield* setStep(stepRunId, {
            state: outcome.state,
            output: outcome.output ?? null,
            error: outcome.error ?? null,
            finishedAt: outcome.state === "waiting_for_approval" ? null : nowIso()
          })
          if (outcome.state === "failed") {
            yield* activity.record({
              kind: "step.failed",
              message: `Step "${step.name}" failed: ${(outcome.error ?? "").split("\n")[0]?.slice(0, 200)}`,
              ticketId: run.ticketId,
              runId: run.id
            })
          } else if (outcome.state === "completed") {
            yield* activity.record({ kind: "step.completed", message: `Step "${step.name}" completed`, ticketId: run.ticketId, runId: run.id })
          }
          yield* notices.publish({ topic: "runs", runId: run.id, ticketId: run.ticketId })
        })

      const context = (run: RunRow) =>
        Effect.gen(function* () {
          const ticket = yield* tickets.get(run.ticketId)
          const project = yield* projects.get(ticket.projectId)
          const ws = run.workspaceId ? yield* workspaces.get(run.workspaceId) : undefined
          if (!ws) return yield* new BadRequest({ message: "Run has no workspace" })
          return { ticket, project, ws }
        })

      const runStepBody = (
        run: RunRow,
        plan: ExecutionPlan,
        step: PlanStep,
        stepRunId: string,
        retryOf: number | undefined
      ): Effect.Effect<StepOutcome, unknown> =>
        Effect.gen(function* () {
          const { ticket, project, ws } = yield* context(run)
          switch (step.kind) {
            case "agent": {
              const parts = [step.promptText ?? ""]
              for (const name of step.context) {
                const a = yield* latestArtifact(run.id, name)
                if (a?.content) parts.push(`## ${name}\n\n${a.content}`)
              }
              if (retryOf !== undefined) {
                const failed = (yield* stepsOf(run.id)).filter((s) => s.stepIndex === retryOf && s.state === "failed").at(-1)
                if (failed) {
                  parts.push(
                    `## Feedback from the previous attempt (step "${failed.stepId}" failed)\n\n${failed.error ?? ""}${failed.output ? `\n\n${tail(failed.output, 8000)}` : ""}`
                  )
                }
              }
              const harness = (run.harnessOverride ?? step.harness ?? ticket.harness ?? project.defaultHarness) as HarnessId
              const session = yield* sessions.start({
                ticketId: run.ticketId,
                harness,
                cwd: ws.path,
                workspaceId: ws.id,
                runId: run.id,
                stepRunId,
                policy: { permissionMode: project.permissionMode },
                prompt: buildTicketPrompt(ticket, parts.join("\n\n"))
              })
              yield* setStep(stepRunId, { sessionId: session.id })
              yield* notices.publish({ topic: "runs", runId: run.id, ticketId: run.ticketId })
              const turn = yield* sessions.awaitTurn(session.id, 0).pipe(
                step.timeoutSec ? Effect.timeoutOption(Duration.seconds(step.timeoutSec)) : Effect.map(Option.some)
              )
              yield* sessions.stop(session.id).pipe(Effect.ignore)
              if (Option.isNone(turn)) return { state: "failed", error: `Agent step timed out after ${step.timeoutSec}s` } as StepOutcome
              if (turn.value.status !== "success") {
                return { state: "failed", error: `Agent turn ended with status ${turn.value.status}`, output: turn.value.text } as StepOutcome
              }
              if (step.output) {
                yield* saveArtifact({ runId: run.id, stepRunId, type: "document", name: step.output, content: turn.value.text })
              }
              return { state: "completed", output: turn.value.text } as StepOutcome
            }
            case "approval": {
              const a = step.artifact ? yield* latestArtifact(run.id, step.artifact) : undefined
              yield* approvals.create({
                ticketId: run.ticketId,
                kind: "workflow_step",
                title: step.title ?? step.name,
                details: { stepId: step.id, artifact: step.artifact, content: a?.content ?? null },
                runId: run.id,
                stepRunId
              })
              return { state: "waiting_for_approval" } as StepOutcome
            }
            case "command": {
              const command = step.command ?? project.testCommand
              if (!command) {
                return { state: "completed", output: "Skipped: no command configured for this project" } as StepOutcome
              }
              const started = Date.now()
              const r = yield* runCommand("sh", ["-c", command], {
                cwd: ws.path,
                timeoutMs: (step.timeoutSec ?? 600) * 1000,
                env: { CI: "1", FORCE_COLOR: "0" }
              })
              const output = tail(`$ ${command}\n${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`)
              yield* saveArtifact({
                runId: run.id,
                stepRunId,
                type: "check",
                name: `${step.id}.log`,
                content: `${output}\n\n[exit ${r.code} in ${((Date.now() - started) / 1000).toFixed(1)}s]`
              })
              return r.code === 0
                ? ({ state: "completed", output } as StepOutcome)
                : ({ state: "failed", error: `\`${command}\` exited with code ${r.code}`, output } as StepOutcome)
            }
            case "pull_request":
              return yield* pullRequestStep(run, step, stepRunId, { ticket, project, ws })
          }
        })

      const pullRequestStep = (
        run: RunRow,
        step: PlanStep,
        stepRunId: string,
        ctx: Effect.Success<ReturnType<typeof context>>
      ): Effect.Effect<StepOutcome, unknown> =>
        Effect.gen(function* () {
          const { ticket, project, ws } = ctx
          const title = step.title ?? `${ticket.identifier}: ${ticket.title}`
          if (step.requiresApproval) {
            const decided = yield* use((db) =>
              db
                .select()
                .from(approvalsTable)
                .where(and(eq(approvalsTable.runId, run.id), eq(approvalsTable.kind, "pull_request")))
                .orderBy(desc(approvalsTable.createdAt))
                .get()
            )
            if (!decided || decided.decision === null) {
              if (!decided) {
                const diff = yield* Git.diffAgainst(ws.path, ws.baseCommit)
                yield* approvals.create({
                  ticketId: run.ticketId,
                  kind: "pull_request",
                  title: `Open ${step.draft ? "draft " : ""}PR: ${title}`,
                  details: {
                    stepId: step.id,
                    branch: ws.branch,
                    base: project.defaultBranch,
                    provider: project.gitProvider,
                    files: diff.files
                  },
                  runId: run.id,
                  stepRunId
                })
              }
              return { state: "waiting_for_approval" }
            }
            if (decided.decision === "deny") return { state: "failed", error: `Pull request rejected${decided.note ? `: ${decided.note}` : ""}` }
          }
          const sha = yield* Git.commitAll(ws.path, `${ticket.identifier}: ${ticket.title}\n\nCreated by AgentDesk run ${run.id}`)
          const head = yield* Git.revParse(ws.path, "HEAD")
          if (head === ws.baseCommit) return { state: "failed", error: "No changes to submit" }
          const provider = prProvider(project.gitProvider)
          if (!provider) {
            yield* saveArtifact({ runId: run.id, stepRunId, type: "branch", name: ws.branch, gitCommit: head })
            return { state: "completed", output: `No git provider configured; changes committed on branch ${ws.branch}` }
          }
          yield* Git.push(ws.path, ws.branch)
          const plan = yield* latestArtifact(run.id, "artifacts/plan.md")
          const review = yield* latestArtifact(run.id, "artifacts/review.md")
          const body = [
            ticket.external ? `Ticket: [${ticket.external.displayKey}](${ticket.external.url})` : `Ticket: ${ticket.identifier}`,
            plan?.content ? `## Plan\n\n${plan.content}` : "",
            review?.content ? `## Agent review\n\n${review.content}` : "",
            "_Opened as a draft by AgentDesk. Not merged automatically._"
          ]
            .filter(Boolean)
            .join("\n\n")
          const pr = yield* provider.create({ cwd: ws.path, branch: ws.branch, base: project.defaultBranch, title, body, draft: step.draft })
          yield* saveArtifact({ runId: run.id, stepRunId, type: "pull_request", name: "pull-request", url: pr.url, gitCommit: sha ?? head })
          yield* activity.record({
            kind: "pr.created",
            message: pr.existing ? `Reused existing pull request ${pr.url}` : `Opened ${step.draft ? "draft " : ""}pull request ${pr.url}`,
            ticketId: run.ticketId,
            runId: run.id,
            actor: "agentdesk",
            data: { url: pr.url }
          })
          if (ticket.status !== "done") yield* tickets.update(ticket.id, { status: "in_review" }, "system").pipe(Effect.ignore)
          return { state: "completed", output: pr.url }
        })

      // ---- executor ------------------------------------------------------------------
      const finishRun = (run: RunRow, status: "completed" | "failed" | "cancelled", error?: string) =>
        Effect.gen(function* () {
          yield* setRun(run.id, { status, error: error ?? null, finishedAt: nowIso(), activeStepId: null })
          if (run.workspaceId) yield* workspaces.unlock(run.workspaceId, run.id)
          yield* activity.record({
            kind: `run.${status}`,
            message: `Workflow ${status}${error ? `: ${error}` : ""}`,
            ticketId: run.ticketId,
            runId: run.id
          })
        })

      const runLoop = (runId: string): Effect.Effect<void, unknown> =>
        Effect.gen(function* () {
          let run = yield* getRunRow(runId)
          if (!run.workspaceId) {
            yield* setRun(runId, { status: "preparing", startedAt: run.startedAt ?? nowIso() })
            const ticket = yield* tickets.get(run.ticketId)
            const project = yield* projects.get(ticket.projectId)
            const ws = yield* workspaces.allocate({
              project,
              ticketId: ticket.id,
              ticketIdentifier: ticket.identifier,
              ticketTitle: ticket.title,
              runId
            })
            yield* workspaces.lock(ws.id, runId)
            run = (yield* setRun(runId, { workspaceId: ws.id }))!
            if (ticket.status === "todo") yield* tickets.update(ticket.id, { status: "in_progress" }, "system").pipe(Effect.ignore)
          } else {
            yield* workspaces.lock(run.workspaceId, runId)
          }
          yield* setRun(runId, { status: "running", startedAt: run.startedAt ?? nowIso() })
          const plan = yield* loadPlan(run.workflowId, run.workflowVersion)
          while (true) {
            run = yield* getRunRow(runId)
            if (TERMINAL.includes(run.status)) return
            const attempts = (yield* stepsOf(runId)).map((s) => ({
              stepIndex: s.stepIndex,
              attempt: s.attempt,
              state: s.state as StepState
            }))
            const action = nextAction(plan, attempts)
            if (action.type === "complete") return yield* finishRun(run, "completed")
            if (action.type === "fail") return yield* finishRun(run, "failed", action.reason)
            if (action.type === "wait") {
              yield* setRun(runId, { status: "waiting_for_approval" })
              return
            }
            yield* executeStep(run, plan, plan.steps[action.stepIndex]!, action.attempt, action.retryOf)
          }
        }).pipe(
          Effect.catch((e) =>
            Effect.gen(function* () {
              const run = yield* getRunRow(runId)
              if (!TERMINAL.includes(run.status)) yield* finishRun(run, "failed", errorMessage(e))
            })
          ),
          Effect.withSpan("workflow.run", { attributes: { runId } }),
          Effect.annotateLogs({ runId })
        )

      /** FIFO scheduler with global and per-project concurrency caps. */
      const pump: Effect.Effect<void, DbError> = Effect.gen(function* () {
        const queued = yield* use((db) =>
          db.select().from(workflowRuns).where(eq(workflowRuns.status, "queued")).orderBy(asc(workflowRuns.createdAt)).all()
        )
        for (const run of queued) {
          if (executors.size >= config.maxConcurrentRuns) return
          if (executors.has(run.id)) continue
          const ticket = yield* tickets.get(run.ticketId).pipe(Effect.option)
          if (Option.isNone(ticket)) continue
          let perProject = 0
          for (const id of executors.keys()) {
            const r = yield* use((db) => db.select({ ticketId: workflowRuns.ticketId }).from(workflowRuns).where(eq(workflowRuns.id, id)).get())
            const t = r ? yield* tickets.get(r.ticketId).pipe(Effect.option) : Option.none()
            if (Option.isSome(t) && t.value.projectId === ticket.value.projectId) perProject++
          }
          if (perProject >= config.maxRunsPerProject) continue
          const fiber = yield* runLoop(run.id).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                executors.delete(run.id)
                return pump.pipe(Effect.ignore)
              })
            ),
            Effect.forkIn(layerScope)
          )
          executors.set(run.id, fiber)
        }
      })

      // ---- public API ------------------------------------------------------------------
      const start = (ticketId: string, body: StartRunBody) =>
        Effect.gen(function* () {
          const ticket = yield* tickets.get(ticketId)
          const project = yield* projects.get(ticket.projectId)
          const workflowId = body.workflowId ?? ticket.workflowId ?? project.defaultWorkflowId ?? DEFAULT_WORKFLOW_ID
          const def = yield* latestDefinition(workflowId)
          const active = yield* use((db) =>
            db
              .select()
              .from(workflowRuns)
              .where(and(eq(workflowRuns.ticketId, ticketId), inArray(workflowRuns.status, [...ACTIVE_RUN_STATES, "waiting_for_approval"])))
              .get()
          )
          if (active) return yield* new BadRequest({ message: "This ticket already has an active workflow run" })
          const row: RunRow = {
            id: newId(),
            ticketId,
            workflowId: def.id,
            workflowVersion: def.version,
            status: "queued",
            activeStepId: null,
            workspaceId: null,
            harnessOverride: body.harness ?? null,
            error: null,
            createdAt: nowIso(),
            startedAt: null,
            finishedAt: null
          }
          yield* use((db) => db.insert(workflowRuns).values(row).run())
          yield* activity.record({
            kind: "run.started",
            message: `Started workflow "${def.name}" v${def.version}`,
            ticketId,
            runId: row.id,
            actor: "user"
          })
          yield* notices.publish({ topic: "runs", runId: row.id, ticketId })
          yield* pump
          return toRun((yield* getRunRow(row.id)) ?? row)
        })

      const get = (id: string) =>
        Effect.gen(function* () {
          const run = yield* getRunRow(id)
          const plan = yield* loadPlan(run.workflowId, run.workflowVersion)
          const steps = yield* stepsOf(id)
          const arts = yield* use((db) => db.select().from(artifacts).where(eq(artifacts.runId, id)).orderBy(asc(artifacts.createdAt)).all())
          const appr = yield* use((db) =>
            db.select().from(approvalsTable).where(eq(approvalsTable.runId, id)).orderBy(asc(approvalsTable.createdAt)).all()
          )
          const ws = run.workspaceId ? yield* workspaces.get(run.workspaceId).pipe(Effect.option) : Option.none()
          return {
            ...toRun(run),
            steps: steps.map(toStep),
            plan: plan.steps.map((s) => ({ id: s.id, kind: s.kind, name: s.name })),
            workspace: Option.getOrNull(ws),
            artifacts: arts.map(toArtifact),
            approvals: appr.map(toApproval)
          } satisfies WorkflowRunDetail
        })

      const interruptExecutor = (id: string) =>
        Effect.gen(function* () {
          const f = executors.get(id)
          if (f) yield* Fiber.interrupt(f)
          executors.delete(id)
        })

      const cancel = (id: string) =>
        Effect.gen(function* () {
          const run = yield* getRunRow(id)
          if (TERMINAL.includes(run.status)) return yield* new BadRequest({ message: `Run is already ${run.status}` })
          yield* interruptExecutor(id)
          const steps = yield* stepsOf(id)
          for (const s of steps.filter((s) => ["running", "waiting_for_approval", "pending"].includes(s.state))) {
            if (s.sessionId) yield* sessions.stop(s.sessionId).pipe(Effect.ignore)
            yield* setStep(s.id, { state: "cancelled", finishedAt: nowIso() })
          }
          yield* use((db) =>
            db
              .update(approvalsTable)
              .set({ decision: "deny", actor: "system", note: "Run cancelled", decidedAt: nowIso() })
              .where(and(eq(approvalsTable.runId, id), isNull(approvalsTable.decision)))
              .run()
          )
          yield* finishRun(run, "cancelled")
          yield* notices.publish({ topic: "approvals", ticketId: run.ticketId })
        })

      const resume = (id: string) =>
        Effect.gen(function* () {
          const run = yield* getRunRow(id)
          if (!["interrupted", "failed"].includes(run.status)) {
            return yield* new BadRequest({ message: `Only interrupted or failed runs can be resumed (run is ${run.status})` })
          }
          yield* setRun(id, { status: "queued", error: null, finishedAt: null })
          yield* activity.record({ kind: "run.resumed", message: "Workflow resumed", ticketId: run.ticketId, runId: id, actor: "user" })
          yield* pump
        })

      const retry = (id: string) =>
        Effect.gen(function* () {
          const run = yield* getRunRow(id)
          if (run.status !== "failed") return yield* new BadRequest({ message: "Only failed runs can be retried" })
          const last = (yield* stepsOf(id)).at(-1)
          // Mark the failed attempt as superseded so the engine re-runs that step as a new attempt.
          if (last && last.state === "failed") {
            yield* setStep(last.id, { state: "interrupted", error: `${last.error ?? ""} (retried by user)`.trim() })
          }
          yield* resume(id)
        })

      const resolveApproval = (approvalId: string, decision: "allow" | "deny", actor: string, note?: string) =>
        Effect.gen(function* () {
          const approval = yield* approvals.record(approvalId, decision, actor, note)
          if (!approval.runId || !approval.stepRunId) return
          const step = yield* use((db) => db.select().from(stepRuns).where(eq(stepRuns.id, approval.stepRunId!)).get())
          if (!step || step.state !== "waiting_for_approval") return
          if (approval.kind === "pull_request" && decision === "allow") {
            // Gate passed; the next attempt performs the (idempotent) PR creation.
            yield* setStep(step.id, { state: "interrupted", output: `Approved by ${actor}`, finishedAt: nowIso() })
          } else {
            yield* setStep(step.id, {
              state: decision === "allow" ? "completed" : "failed",
              output: decision === "allow" ? `Approved by ${actor}${note ? `: ${note}` : ""}` : null,
              error: decision === "deny" ? `Rejected by ${actor}${note ? `: ${note}` : ""}` : null,
              finishedAt: nowIso()
            })
          }
          yield* activity.record({
            kind: "approval.decided",
            message: `${decision === "allow" ? "Approved" : "Rejected"}: ${approval.title}${note ? ` — ${note}` : ""}`,
            ticketId: approval.ticketId,
            runId: approval.runId,
            actor
          })
          yield* setRun(approval.runId, { status: "queued" })
          yield* pump
        })

      const reconcile = Effect.gen(function* () {
        const stale = yield* use((db) =>
          db.select().from(workflowRuns).where(inArray(workflowRuns.status, ["preparing", "running", "retrying"])).all()
        )
        yield* tx((db) => {
          for (const r of stale) {
            db.update(workflowRuns).set({ status: "interrupted", activeStepId: null }).where(eq(workflowRuns.id, r.id)).run()
            db.update(stepRuns)
              .set({ state: "interrupted", error: "Daemon restarted during this step", finishedAt: nowIso() })
              .where(and(eq(stepRuns.runId, r.id), eq(stepRuns.state, "running")))
              .run()
          }
        })
        for (const r of stale) {
          if (r.workspaceId) yield* workspaces.unlock(r.workspaceId, r.id)
          yield* activity.record({
            kind: "run.interrupted",
            message: "Workflow interrupted by a daemon restart; resume to continue from the interrupted step",
            ticketId: r.ticketId,
            runId: r.id
          })
        }
        yield* pump
        return stale.length
      })

      return {
        definitions: use((db) =>
          db.select().from(workflowDefinitions).orderBy(asc(workflowDefinitions.id), desc(workflowDefinitions.version)).all()
        ).pipe(
          Effect.map((rows) => {
            const seen = new Set<string>()
            return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).map(summary)
          })
        ),
        definition: latestDefinition,
        save: (yaml) =>
          compile(yaml).pipe(
            Effect.mapError((e) => new BadRequest({ message: e.message, details: e.errors })),
            Effect.flatMap((plan) => insertDefinition(yaml, plan))
          ),
        validate: (yaml) =>
          compile(yaml).pipe(
            Effect.map(() => ({ ok: true, errors: [] as ReadonlyArray<string> })),
            Effect.catch((e) => Effect.succeed({ ok: false, errors: e.errors }))
          ),
        start,
        get,
        list: ({ ticketId, status }) =>
          use((db) =>
            db
              .select()
              .from(workflowRuns)
              .where(and(ticketId ? eq(workflowRuns.ticketId, ticketId) : undefined, status ? eq(workflowRuns.status, status) : undefined))
              .orderBy(desc(workflowRuns.createdAt))
              .limit(200)
              .all()
              .map(toRun)
          ),
        cancel,
        resume,
        retry,
        resolveApproval,
        artifact: (id) =>
          use((db) => db.select().from(artifacts).where(eq(artifacts.id, id)).get()).pipe(
            Effect.flatMap((r) => (r ? Effect.succeed(toArtifact(r)) : Effect.fail(new NotFound({ entity: "artifact", id }))))
          ),
        activeCount: () => executors.size,
        reconcile
      } satisfies WorkflowsShape
    })
  )
