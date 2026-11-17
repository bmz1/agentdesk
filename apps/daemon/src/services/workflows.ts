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
import { type HarnessError, runCommand } from "@agentdesk/harness-core"
import { compileWorkflow, type ExecutionPlan, nextAction, type PlanStep, type WorkflowValidationError } from "@agentdesk/workflows"
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { Context, Duration, Effect, FiberMap, Layer, Option, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { DaemonConfig } from "../config"
import { BadRequest, Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { Approvals, toApproval } from "./approvals"
import { Database } from "./database"
import { EventLog } from "./event-log"
import { Notices } from "./notices"
import { Projects } from "./projects"
import { HarnessSettings } from "./harness-settings"
import { buildTicketPrompt, projectPolicy, Sessions, ticketEffort, ticketModel } from "./sessions"
import { Tickets } from "./tickets"
import { Workspaces } from "./workspaces"

export const DEFAULT_WORKFLOW_ID = "plan-implement-test-pr"
const ACTIVE_RUN_STATES = ["queued", "preparing", "running", "retrying"]
const TERMINAL = ["completed", "failed", "cancelled"]

type RunRow = typeof workflowRuns.$inferSelect
type StepRow = typeof stepRuns.$inferSelect

/** Every typed failure a workflow step (or the run loop around it) can produce. */
export type StepError =
  | NotFound
  | BadRequest
  | Conflict
  | DbError
  | HarnessError
  | Git.GitError
  | Git.PullRequestError

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
  readonly save: (yaml: string) => Effect.Effect<WorkflowDefinitionSummary, WorkflowValidationError | Conflict | DbError>
  readonly validate: (yaml: string) => Effect.Effect<{ ok: boolean; errors: ReadonlyArray<string> }>
  readonly start: (ticketId: string, body: StartRunBody) => Effect.Effect<WorkflowRun, NotFound | BadRequest | DbError>
  readonly get: (id: string) => Effect.Effect<WorkflowRunDetail, NotFound | DbError>
  readonly list: (filter: { ticketId?: string; status?: string }) => Effect.Effect<ReadonlyArray<WorkflowRun>, DbError>
  readonly cancel: (id: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
  readonly resume: (id: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
  /**
   * A follow-up was sent to a step session of an interrupted run: resume the run so the step
   * continues with that conversation. No-op for any other session.
   */
  readonly continueFromSession: (sessionId: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
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

const tail = (s: string, n = 20_000) => (s.length > n ? "…\n" + s.slice(-n) : s)

export const WorkflowsLive = (options: WorkflowsOptions = {}) =>
  Layer.effect(
    Workflows,
    Effect.gen(function* () {
      const config = yield* DaemonConfig
      const harnessSettings = yield* HarnessSettings
      const { use, tx } = yield* Database
      const notices = yield* Notices
      const activity = yield* Activity
      const approvals = yield* Approvals
      const sessions = yield* Sessions
      const events = yield* EventLog
      const tickets = yield* Tickets
      const projects = yield* Projects
      const workspaces = yield* Workspaces
      const prProvider = options.prProvider ?? Git.providerFor
      const withProcesses = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner)

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
          const row = { id: plan.id, version: plan.version, name: plan.name, yaml, plan, createdAt: yield* nowIso }
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

      const saveArtifact = Effect.fnUntraced(function* (input: {
        runId: string
        stepRunId: string | null
        type: string
        name: string
        content?: string | null
        url?: string | null
        gitCommit?: string | null
      }) {
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
          createdAt: yield* nowIso
        }
        yield* use((db) => db.insert(artifacts).values(row).run())
        return row
      })

      const latestArtifact = (runId: string, name: string) =>
        use((db) =>
          db.select().from(artifacts).where(and(eq(artifacts.runId, runId), eq(artifacts.name, name))).orderBy(desc(artifacts.createdAt)).get()
        )

      const context = Effect.fnUntraced(function* (run: RunRow) {
        const ticket = yield* tickets.get(run.ticketId)
        const project = yield* projects.get(ticket.projectId)
        const ws = run.workspaceId ? yield* workspaces.get(run.workspaceId) : undefined
        if (!ws) return yield* new BadRequest({ message: "Run has no workspace" })
        return { ticket, project, ws }
      })
      type RunContext = Effect.Success<ReturnType<typeof context>>

      // ---- step kinds -----------------------------------------------------------------
      /**
       * An agent step interrupted by a daemon restart whose conversation the user then continued
       * by hand. The step adopts that conversation's latest turn instead of starting over.
       */
      const continuedSession = (runId: string, stepId: string, stepRunId: string) =>
        Effect.gen(function* () {
          const prev = (yield* stepsOf(runId))
            .filter((s) => s.stepId === stepId && s.state === "interrupted" && s.sessionId && s.id !== stepRunId)
            .at(-1)
          if (!prev?.sessionId) return undefined
          const history = yield* events.history(prev.sessionId, { limit: 100_000 })
          const interruptedAt = history.find((e) => e.event.type === "session.status" && e.event.state === "interrupted")?.id
          if (interruptedAt === undefined) return undefined
          const prompt = history.filter((e) => e.id > interruptedAt && e.event.type === "user.prompt").at(-1)
          if (!prompt) return undefined
          const finished = history.some((e) => e.id > prompt.id && e.event.type === "turn.completed")
          // A turn that never finished and has no live process would wait forever: start over instead.
          if (!finished && !sessions.isLive(prev.sessionId)) return undefined
          return { sessionId: prev.sessionId, afterEventId: prompt.id }
        })

      const agentStep = Effect.fn("Workflow.agentStep")(function* (
        run: RunRow,
        step: PlanStep,
        stepRunId: string,
        retryOf: number | undefined,
        { ticket, project, ws }: RunContext
      ): Effect.fn.Return<StepOutcome, StepError> {
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
        yield* Effect.annotateCurrentSpan({ harness, contextArtifacts: step.context.length, isRetry: retryOf !== undefined })
        const continued = retryOf === undefined ? yield* continuedSession(run.id, step.id, stepRunId) : undefined
        if (continued) {
          yield* setStep(stepRunId, { sessionId: continued.sessionId })
          yield* notices.publish({ topic: "runs", runId: run.id, ticketId: run.ticketId })
          yield* activity.record({
            kind: "step.continued",
            message: `Step "${step.name}" continues with the conversation resumed after the interruption`,
            ticketId: run.ticketId,
            runId: run.id
          })
        }
        const session = continued ? { id: continued.sessionId } : yield* sessions.start({
          ticketId: run.ticketId,
          harness,
          cwd: ws.path,
          workspaceId: ws.id,
          runId: run.id,
          stepRunId,
          policy: yield* projectPolicy(
            project,
            config.sandboxPrefix,
            ticketModel(ticket, project, harness),
            (yield* harnessSettings.get).harnesses[harness],
            ticketEffort(ticket, project, harness)
          ),
          prompt: buildTicketPrompt(ticket, parts.join("\n\n"))
        })
        if (!continued) {
          yield* setStep(stepRunId, { sessionId: session.id })
          yield* notices.publish({ topic: "runs", runId: run.id, ticketId: run.ticketId })
        }
        const turn = yield* sessions
          .awaitTurn(session.id, continued?.afterEventId ?? 0)
          .pipe(step.timeoutSec ? Effect.timeoutOption(Duration.seconds(step.timeoutSec)) : Effect.map(Option.some))
        yield* sessions.stop(session.id).pipe(Effect.ignore)
        if (Option.isNone(turn)) return { state: "failed", error: `Agent step timed out after ${step.timeoutSec}s` }
        if (turn.value.status !== "success") {
          return { state: "failed", error: `Agent turn ended with status ${turn.value.status}`, output: turn.value.text }
        }
        if (step.output) {
          yield* saveArtifact({ runId: run.id, stepRunId, type: "document", name: step.output, content: turn.value.text })
        }
        return { state: "completed", output: turn.value.text }
      })

      const approvalStep = Effect.fn("Workflow.approvalStep")(function* (run: RunRow, step: PlanStep, stepRunId: string) {
        const a = step.artifact ? yield* latestArtifact(run.id, step.artifact) : undefined
        yield* approvals.create({
          ticketId: run.ticketId,
          kind: "workflow_step",
          title: step.title ?? step.name,
          details: { stepId: step.id, artifact: step.artifact, content: a?.content ?? null },
          runId: run.id,
          stepRunId
        })
        return { state: "waiting_for_approval" } satisfies StepOutcome
      })

      const commandStep = Effect.fn("Workflow.commandStep")(function* (
        run: RunRow,
        step: PlanStep,
        stepRunId: string,
        { project, ws }: RunContext
      ): Effect.fn.Return<StepOutcome, StepError> {
        const command = step.command ?? project.testCommand
        if (!command) return { state: "completed", output: "Skipped: no command configured for this project" }
        yield* Effect.annotateCurrentSpan({ command })
        const r = yield* runCommand("sh", ["-c", command], {
          cwd: ws.path,
          timeoutMs: (step.timeoutSec ?? 600) * 1000,
          env: { CI: "1", FORCE_COLOR: "0" }
        }).pipe(withProcesses, Effect.timed)
        const [elapsed, result] = r
        yield* Effect.annotateCurrentSpan({ exitCode: result.code ?? -1, durationMs: Duration.toMillis(elapsed) })
        const output = tail(`$ ${command}\n${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`)
        yield* saveArtifact({
          runId: run.id,
          stepRunId,
          type: "check",
          name: `${step.id}.log`,
          content: `${output}\n\n[exit ${result.code} in ${(Duration.toMillis(elapsed) / 1000).toFixed(1)}s]`
        })
        return result.code === 0
          ? { state: "completed", output }
          : { state: "failed", error: `\`${command}\` exited with code ${result.code}`, output }
      })

      const pullRequestStep = Effect.fn("Workflow.pullRequestStep")(function* (
        run: RunRow,
        step: PlanStep,
        stepRunId: string,
        { ticket, project, ws }: RunContext
      ): Effect.fn.Return<StepOutcome, StepError, ChildProcessSpawner.ChildProcessSpawner> {
        const title = step.title ?? `${ticket.identifier}: ${ticket.title}`
        yield* Effect.annotateCurrentSpan({ branch: ws.branch, provider: project.gitProvider, draft: step.draft })
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
                details: { stepId: step.id, branch: ws.branch, base: project.defaultBranch, provider: project.gitProvider, files: diff.files },
                runId: run.id,
                stepRunId
              })
            }
            return { state: "waiting_for_approval" }
          }
          if (decided.decision === "deny") {
            return { state: "failed", error: `Pull request rejected${decided.note ? `: ${decided.note}` : ""}` }
          }
        }
        const sha = yield* Git.commitAll(ws.path, `${ticket.identifier}: ${ticket.title}\n\nCreated by AgentDesk run ${run.id}`)
        const head = yield* Git.revParse(ws.path, "HEAD")
        if (head === ws.baseCommit) return { state: "failed", error: "No changes to submit" }
        const provider = prProvider(project.gitProvider)
        if (!provider) {
          yield* saveArtifact({ runId: run.id, stepRunId, type: "branch", name: ws.branch, gitCommit: head })
          return { state: "completed", output: `No git provider configured; changes committed on branch ${ws.branch}` }
        }
        yield* Git.push(ws.path, ws.branch).pipe(Effect.withSpan("Git.push", { attributes: { branch: ws.branch } }))
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
        // Idempotent: providers reuse an open PR for the branch, so retries never duplicate.
        const pr = yield* provider
          .create({ cwd: ws.path, branch: ws.branch, base: project.defaultBranch, title, body, draft: step.draft })
          .pipe(Effect.withSpan("PullRequest.create", { attributes: { provider: provider.id } }))
        yield* Effect.annotateCurrentSpan({ prUrl: pr.url, reusedExistingPr: pr.existing })
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

      const runStepBody = (
        run: RunRow,
        step: PlanStep,
        stepRunId: string,
        retryOf: number | undefined
      ): Effect.Effect<StepOutcome, StepError> =>
        Effect.gen(function* () {
          const ctx = yield* context(run)
          switch (step.kind) {
            case "agent":
              return yield* agentStep(run, step, stepRunId, retryOf, ctx)
            case "approval":
              return yield* approvalStep(run, step, stepRunId)
            case "command":
              return yield* commandStep(run, step, stepRunId, ctx)
            case "pull_request":
              return yield* pullRequestStep(run, step, stepRunId, ctx).pipe(withProcesses)
          }
        })

      /** Execute one step attempt: durable claim, run, record the outcome. */
      const executeStep = Effect.fn("Workflow.step")(function* (
        run: RunRow,
        plan: ExecutionPlan,
        step: PlanStep,
        attempt: number,
        retryOf: number | undefined
      ) {
        const stepRunId = newId()
        yield* Effect.annotateCurrentSpan({
          runId: run.id,
          ticketId: run.ticketId,
          stepId: step.id,
          stepKind: step.kind,
          attempt,
          retryOf: retryOf !== undefined ? (plan.steps[retryOf]?.id ?? "") : ""
        })
        const startedAt = yield* nowIso
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
              startedAt,
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
        const outcome = yield* runStepBody(run, step, stepRunId, retryOf).pipe(
          // Typed failures become a failed step (and feed retry/feedback); defects still crash the fiber.
          Effect.catch((e) => Effect.succeed<StepOutcome>({ state: "failed", error: `${e._tag}: ${e.message}` }))
        )
        yield* Effect.annotateCurrentSpan({ outcome: outcome.state })
        yield* setStep(stepRunId, {
          state: outcome.state,
          output: outcome.output ?? null,
          error: outcome.error ?? null,
          finishedAt: outcome.state === "waiting_for_approval" ? null : yield* nowIso
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

      // ---- executor ------------------------------------------------------------------
      const finishRun = Effect.fnUntraced(function* (run: RunRow, status: "completed" | "failed" | "cancelled", error?: string) {
        yield* setRun(run.id, { status, error: error ?? null, finishedAt: yield* nowIso, activeStepId: null })
        if (run.workspaceId) yield* workspaces.unlock(run.workspaceId, run.id)
        yield* Effect.annotateCurrentSpan({ runStatus: status })
        yield* activity.record({
          kind: `run.${status}`,
          message: `Workflow ${status}${error ? `: ${error}` : ""}`,
          ticketId: run.ticketId,
          runId: run.id
        })
      })

      /**
       * Drive a run until it completes, fails or reaches a durable wait. All state
       * lives in SQLite; this fiber can be interrupted or lost at any point.
       */
      const runLoop = Effect.fn("Workflow.run")(
        function* (runId: string): Effect.fn.Return<void, StepError> {
          let run = yield* getRunRow(runId)
          yield* Effect.annotateCurrentSpan({ runId, ticketId: run.ticketId, workflow: `${run.workflowId}@${run.workflowVersion}` })
          if (!run.workspaceId) {
            yield* setRun(runId, { status: "preparing", startedAt: run.startedAt ?? (yield* nowIso) })
            const ticket = yield* tickets.get(run.ticketId)
            const project = yield* projects.get(ticket.projectId)
            const ws = yield* workspaces.allocate({ project, ticketId: ticket.id, ticketIdentifier: ticket.identifier, ticketTitle: ticket.title, runId })
            yield* workspaces.lock(ws.id, runId)
            run = (yield* setRun(runId, { workspaceId: ws.id }))!
            if (ticket.status === "todo") yield* tickets.update(ticket.id, { status: "in_progress" }, "system").pipe(Effect.ignore)
          } else {
            yield* workspaces.lock(run.workspaceId, runId)
          }
          yield* setRun(runId, { status: "running", startedAt: run.startedAt ?? (yield* nowIso) })
          const plan = yield* loadPlan(run.workflowId, run.workflowVersion)
          while (true) {
            run = yield* getRunRow(runId)
            if (TERMINAL.includes(run.status)) return
            const attempts = (yield* stepsOf(runId)).map((s) => ({ stepIndex: s.stepIndex, attempt: s.attempt, state: s.state as StepState }))
            const action = nextAction(plan, attempts)
            if (action.type === "complete") return yield* finishRun(run, "completed")
            if (action.type === "fail") return yield* finishRun(run, "failed", action.reason)
            if (action.type === "wait") {
              yield* setRun(runId, { status: "waiting_for_approval" })
              yield* Effect.annotateCurrentSpan({ runStatus: "waiting_for_approval" })
              return
            }
            yield* executeStep(run, plan, plan.steps[action.stepIndex]!, action.attempt, action.retryOf)
          }
        },
        (effect, runId) =>
          effect.pipe(
            Effect.catch((e) =>
              Effect.gen(function* () {
                const run = yield* getRunRow(runId)
                if (!TERMINAL.includes(run.status)) yield* finishRun(run, "failed", `${e._tag}: ${e.message}`)
              }).pipe(Effect.catch((inner) => Effect.logError("could not record run failure", inner)))
            ),
            Effect.annotateLogs({ runId })
          )
      )

      // ---- scheduling --------------------------------------------------------------------
      // FIFO admission with a global and a per-project cap. A run first takes its project's
      // permit, then a global one, so runs waiting on a busy project never hold a global slot.
      // Semaphore waiters are served in order, so admission stays first-come-first-served.
      const executors = yield* FiberMap.make<string>()
      const globalSlots = yield* Semaphore.make(config.maxConcurrentRuns)
      const projectSlots = new Map<string, Semaphore.Semaphore>()
      let running = 0
      const projectSlot = (projectId: string) => {
        let s = projectSlots.get(projectId)
        if (!s) {
          s = Semaphore.makeUnsafe(config.maxRunsPerProject)
          projectSlots.set(projectId, s)
        }
        return s
      }

      const schedule = Effect.fn("Workflow.schedule")(function* (runId: string) {
        const run = yield* getRunRow(runId)
        const ticket = yield* tickets.get(run.ticketId)
        yield* Effect.annotateCurrentSpan({ runId, projectId: ticket.projectId })
        const admitted = Effect.acquireUseRelease(
          Effect.sync(() => void running++),
          () => runLoop(runId),
          () => Effect.sync(() => void running--)
        ).pipe(Semaphore.withPermit(globalSlots), Semaphore.withPermit(projectSlot(ticket.projectId)))
        yield* FiberMap.run(executors, runId, admitted, { onlyIfMissing: true })
      })

      // ---- public API ------------------------------------------------------------------
      const start = Effect.fn("Workflows.start")(function* (ticketId: string, body: StartRunBody) {
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
          createdAt: yield* nowIso,
          startedAt: null,
          finishedAt: null
        }
        yield* Effect.annotateCurrentSpan({ runId: row.id, ticketId, workflow: `${def.id}@${def.version}` })
        yield* use((db) => db.insert(workflowRuns).values(row).run())
        yield* activity.record({ kind: "run.started", message: `Started workflow "${def.name}" v${def.version}`, ticketId, runId: row.id, actor: "user" })
        yield* notices.publish({ topic: "runs", runId: row.id, ticketId })
        yield* schedule(row.id)
        return toRun(row)
      })

      const get = Effect.fn("Workflows.get")(function* (id: string) {
        const run = yield* getRunRow(id)
        const plan = yield* loadPlan(run.workflowId, run.workflowVersion)
        const steps = yield* stepsOf(id)
        const arts = yield* use((db) => db.select().from(artifacts).where(eq(artifacts.runId, id)).orderBy(asc(artifacts.createdAt)).all())
        const appr = yield* use((db) => db.select().from(approvalsTable).where(eq(approvalsTable.runId, id)).orderBy(asc(approvalsTable.createdAt)).all())
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

      const cancel = Effect.fn("Workflows.cancel")(function* (id: string) {
        const run = yield* getRunRow(id)
        yield* Effect.annotateCurrentSpan({ runId: id, ticketId: run.ticketId, from: run.status })
        if (TERMINAL.includes(run.status)) return yield* new BadRequest({ message: `Run is already ${run.status}` })
        // Interrupt the executor fiber (if any); durable state is then settled below.
        yield* FiberMap.remove(executors, id)
        const now = yield* nowIso
        for (const s of (yield* stepsOf(id)).filter((s) => ["running", "waiting_for_approval", "pending"].includes(s.state))) {
          if (s.sessionId) yield* sessions.stop(s.sessionId).pipe(Effect.ignore)
          yield* setStep(s.id, { state: "cancelled", finishedAt: now })
        }
        yield* use((db) =>
          db
            .update(approvalsTable)
            .set({ decision: "deny", actor: "system", note: "Run cancelled", decidedAt: now })
            .where(and(eq(approvalsTable.runId, id), isNull(approvalsTable.decision)))
            .run()
        )
        yield* finishRun(run, "cancelled")
        yield* notices.publish({ topic: "approvals", ticketId: run.ticketId })
      })

      const resume = Effect.fn("Workflows.resume")(function* (id: string) {
        const run = yield* getRunRow(id)
        yield* Effect.annotateCurrentSpan({ runId: id, from: run.status })
        if (!["interrupted", "failed"].includes(run.status)) {
          return yield* new BadRequest({ message: `Only interrupted or failed runs can be resumed (run is ${run.status})` })
        }
        yield* setRun(id, { status: "queued", error: null, finishedAt: null })
        yield* activity.record({ kind: "run.resumed", message: "Workflow resumed", ticketId: run.ticketId, runId: id, actor: "user" })
        yield* schedule(id)
      })

      const continueFromSession = Effect.fn("Workflows.continueFromSession")(function* (sessionId: string) {
        const session = yield* sessions.get(sessionId)
        if (!session.runId) return
        const run = yield* getRunRow(session.runId)
        if (run.status !== "interrupted") return
        const last = (yield* stepsOf(run.id)).at(-1)
        if (last?.sessionId !== sessionId || last.state !== "interrupted") return
        yield* resume(run.id)
      })

      const retry = Effect.fn("Workflows.retry")(function* (id: string) {
        const run = yield* getRunRow(id)
        if (run.status !== "failed") return yield* new BadRequest({ message: "Only failed runs can be retried" })
        const last = (yield* stepsOf(id)).at(-1)
        // Mark the failed attempt as superseded so the engine re-runs that step as a new attempt.
        if (last && last.state === "failed") {
          yield* setStep(last.id, { state: "interrupted", error: `${last.error ?? ""} (retried by user)`.trim() })
        }
        yield* resume(id)
      })

      const resolveApproval = Effect.fn("Workflows.resolveApproval")(function* (
        approvalId: string,
        decision: "allow" | "deny",
        actor: string,
        note?: string
      ) {
        const approval = yield* approvals.record(approvalId, decision, actor, note)
        yield* Effect.annotateCurrentSpan({ approvalId, decision, kind: approval.kind, runId: approval.runId ?? "" })
        if (!approval.runId || !approval.stepRunId) return
        const step = yield* use((db) => db.select().from(stepRuns).where(eq(stepRuns.id, approval.stepRunId!)).get())
        if (!step || step.state !== "waiting_for_approval") return
        const finishedAt = yield* nowIso
        if (approval.kind === "pull_request" && decision === "allow") {
          // Gate passed; the next attempt performs the (idempotent) PR creation.
          yield* setStep(step.id, { state: "interrupted", output: `Approved by ${actor}`, finishedAt })
        } else {
          yield* setStep(step.id, {
            state: decision === "allow" ? "completed" : "failed",
            output: decision === "allow" ? `Approved by ${actor}${note ? `: ${note}` : ""}` : null,
            error: decision === "deny" ? `Rejected by ${actor}${note ? `: ${note}` : ""}` : null,
            finishedAt
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
        yield* schedule(approval.runId)
      })

      const reconcile = Effect.gen(function* () {
        const now = yield* nowIso
        const stale = yield* use((db) =>
          db.select().from(workflowRuns).where(inArray(workflowRuns.status, ["preparing", "running", "retrying"])).all()
        )
        yield* tx((db) => {
          for (const r of stale) {
            db.update(workflowRuns).set({ status: "interrupted", activeStepId: null }).where(eq(workflowRuns.id, r.id)).run()
            db.update(stepRuns)
              .set({ state: "interrupted", error: "Daemon restarted during this step", finishedAt: now })
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
        // Re-admit queued runs in their original order.
        const queued = yield* use((db) =>
          db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.status, "queued")).orderBy(asc(workflowRuns.createdAt)).all()
        )
        for (const q of queued) yield* schedule(q.id).pipe(Effect.catch((e) => Effect.logWarning("could not schedule run", e)))
        yield* Effect.annotateCurrentSpan({ interrupted: stale.length, requeued: queued.length })
        return stale.length
      }).pipe(Effect.withSpan("Workflows.reconcile"))

      return Workflows.of({
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
            Effect.flatMap((plan) => insertDefinition(yaml, plan)),
            Effect.withSpan("Workflows.save")
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
        continueFromSession,
        retry,
        resolveApproval,
        artifact: (id) =>
          use((db) => db.select().from(artifacts).where(eq(artifacts.id, id)).get()).pipe(
            Effect.flatMap((r) => (r ? Effect.succeed(toArtifact(r)) : Effect.fail(new NotFound({ entity: "artifact", id }))))
          ),
        activeCount: () => running,
        reconcile
      })
    })
  )
