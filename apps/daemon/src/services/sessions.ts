import { existsSync } from "node:fs"
import type {
  ImageRef,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  HarnessDefaults,
  QuestionAnswers,
  HarnessId,
  PermissionMode,
  Project,
  SessionState,
  Ticket,
  Workspace
} from "@agentdesk/contracts"
import { LIVE_SESSION_STATES } from "@agentdesk/contracts"
import { agentSessions } from "@agentdesk/db"
import * as Git from "@agentdesk/git"
import { type HarnessError, type HarnessSession, type PromptImage, type RunPolicy, runCommand } from "@agentdesk/harness-core"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Exit, FiberMap, Layer, Option, Scope, Semaphore, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { BadRequest, type Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { DaemonConfig } from "../config"
import { Activity } from "./activity"
import { Approvals } from "./approvals"
import { Attachments } from "./attachments"
import { Database } from "./database"
import { addTurnUsage, EventLog, planSummary, previewText, type SessionPlan, type SessionUsage } from "./event-log"
import { Limits } from "./limits"
import { HarnessSettings } from "./harness-settings"
import { Harnesses } from "./harnesses"
import { Notices } from "./notices"
import { Projects } from "./projects"
import { Tickets } from "./tickets"
import { pendingSetup, Workspaces } from "./workspaces"

type Row = typeof agentSessions.$inferSelect

export const LIVE_STATES = LIVE_SESSION_STATES

const oneLine = (text: string, max = 96) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The most telling argument of a tool call: the command, path, pattern or query it acts on. */
const toolArgument = (input: unknown): string | undefined => {
  if (typeof input === "string") return input
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "file_path", "filePath", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join(" ")
  }
  return undefined
}

/**
 * One line on what a live session is doing, derived from the event it just produced
 * (the equivalent of a terminal's program-status line). `undefined` leaves the line unchanged.
 */
export const describeEvent = (event: AgentEvent): string | undefined => {
  switch (event.type) {
    case "user.prompt":
      return "Reading the prompt"
    case "reasoning":
      return "Thinking"
    case "message.delta":
      return "Writing a reply"
    case "tool.started": {
      const arg = toolArgument(event.input)
      return oneLine(arg ? `${event.name}: ${arg}` : event.name)
    }
    case "approval.requested":
      return oneLine(event.kind === "question" ? `Asks: ${event.summary}` : `Needs approval: ${event.summary}`)
    case "plan.updated": {
      const plan = planSummary(event.items)
      if (!plan) return undefined
      return oneLine(plan.current ? `Step ${Math.min(plan.done + 1, plan.total)}/${plan.total}: ${plan.current}` : `Plan done (${plan.total}/${plan.total})`)
    }
    case "approval.resolved":
      return event.answers ? "Answered, continuing" : event.decision === "allow" ? "Approved, continuing" : "Denied, continuing"
    case "turn.completed":
      return event.status === "error" ? "Turn failed" : event.status === "interrupted" ? "Turn interrupted" : "Turn finished"
    case "session.error":
      return oneLine(event.message)
    default:
      return undefined
  }
}

export interface StartSessionInput {
  readonly ticketId: string
  readonly harness: HarnessId
  readonly cwd: string
  readonly policy: RunPolicy
  readonly prompt?: string
  /** Attachment ids sent with the first prompt. */
  readonly images?: ReadonlyArray<string>
  readonly workspaceId?: string | null
  readonly runId?: string | null
  readonly stepRunId?: string | null
  /** The session's worktree: when the project's setup script still has to run there, it runs before the agent starts. */
  readonly setup?: { readonly workspace: Workspace; readonly project: Project }
}

export interface StartForTicketInput {
  readonly harness?: HarnessId
  readonly prompt?: string
  readonly images?: ReadonlyArray<string>
}

export interface PromptSwitches {
  readonly model?: string | null
  readonly effort?: string | null
  readonly permissionMode?: PermissionMode | null
}

export interface TurnResult {
  readonly status: "success" | "error" | "interrupted" | "exited"
  /** Concatenated final assistant messages of the turn. */
  readonly text: string
  readonly lastEventId: number
}

type SessionError = NotFound | BadRequest | Conflict | DbError | HarnessError | Git.GitError

export interface SessionsShape {
  readonly start: (input: StartSessionInput) => Effect.Effect<AgentSession, SessionError>
  readonly startForTicket: (ticketId: string, input: StartForTicketInput) => Effect.Effect<AgentSession, SessionError>
  readonly get: (id: string) => Effect.Effect<AgentSession, NotFound | DbError>
  readonly list: (filter: { ticketId?: string; active?: boolean; limit?: number }) => Effect.Effect<ReadonlyArray<AgentSession>, DbError>
  /** Send a follow-up. Transparently resumes the provider conversation if the process is gone. */
  readonly prompt: (
    id: string,
    text: string,
    actor?: string,
    images?: ReadonlyArray<string>,
    /** Switch model or effort from this turn on (null: default). Omitted keeps the current one. */
    switches?: PromptSwitches
  ) => Effect.Effect<void, SessionError>
  readonly interrupt: (id: string) => Effect.Effect<void, SessionError>
  /** Terminate the harness process. */
  readonly stop: (id: string) => Effect.Effect<void, SessionError>
  readonly resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    actor: string,
    note?: string,
    options?: { readonly scope?: "once" | "session"; readonly answers?: QuestionAnswers }
  ) => Effect.Effect<void, SessionError>
  /** Wait until the session's current turn completes (or the process exits). */
  readonly awaitTurn: (id: string, afterEventId: number) => Effect.Effect<TurnResult, DbError>
  readonly isLive: (id: string) => boolean
  readonly liveCount: () => number
  /**
   * Startup reconciliation of sessions left "live" by a previous daemon: user conversations wait
   * idle for a follow-up (which resumes them); workflow steps are marked interrupted.
   */
  readonly reconcile: Effect.Effect<number, DbError>
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()("agentdesk/Sessions") {}

interface LiveSession {
  readonly handle: HarnessSession
  readonly scope: Scope.Closeable
  readonly harness: HarnessId
  readonly lockHolder: string | undefined
  readonly workspaceId: string | null
  stopping: boolean
  /** Stopped only to relaunch with new settings (effort): not an ended session. */
  restarting: boolean
  exitCode: number | null | undefined
}

/** The permission mode a run gets: the ticket's own choice, else the project's, else the harness defaults. */
export const effectivePermissionMode = (project: Project, defaults?: HarnessDefaults, ticketMode?: PermissionMode | null): PermissionMode =>
  ticketMode ?? (project.inheritHarnessPermissions ? defaults?.permissionMode ?? "ask" : project.permissionMode)

const unrestrictedWithoutSandbox = () =>
  new BadRequest({ message: "Unrestricted permission mode requires a sandbox (set AGENTDESK_SANDBOX_CMD). Choose another permission mode or configure a sandbox." })

/**
 * Build the harness run policy for a project. Unrestricted mode is refused
 * unless a real sandbox is configured: a git worktree is not a sandbox.
 */
export const projectPolicy = (
  project: Project,
  sandboxPrefix: ReadonlyArray<string> | undefined,
  model?: string | null,
  defaults?: HarnessDefaults,
  effort?: string | null,
  /** The ticket's permission mode; null or omitted follows the project. */
  ticketPermissionMode?: PermissionMode | null
) => {
  const permissionMode = effectivePermissionMode(project, defaults, ticketPermissionMode)
  return permissionMode === "unrestricted" && !sandboxPrefix?.length
    ? Effect.fail(unrestrictedWithoutSandbox())
    : Effect.succeed<RunPolicy>({
        permissionMode,
        ...((model ?? defaults?.model) && { model: (model ?? defaults?.model)! }),
        ...(effort && { effort }),
        ...(defaults?.instructions && { appendSystemPrompt: defaults.instructions }),
        ...(permissionMode === "unrestricted" && { sandboxPrefix })
      })
}

/**
 * The ticket's model applies only when the run uses the ticket's own harness;
 * a model id is meaningless to another harness, which then uses its default.
 */
export const ticketModel = (ticket: Ticket, project: Project, harness: HarnessId) =>
  harness === (ticket.harness ?? project.defaultHarness) ? ticket.model : null

/** Same rule as the model: effort levels only mean something to the ticket's own harness. */
export const ticketEffort = (ticket: Ticket, project: Project, harness: HarnessId) =>
  harness === (ticket.harness ?? project.defaultHarness) ? ticket.effort : null

export const buildTicketPrompt = (ticket: Ticket, extra?: string, inWorktree = true) =>
  [
    `You are working on ticket ${ticket.identifier}: ${ticket.title}`,
    ticket.description ? `\n## Description\n${ticket.description}` : "",
    ticket.acceptanceCriteria ? `\n## Acceptance criteria\n${ticket.acceptanceCriteria}` : "",
    inWorktree ? "\nYou are running inside a dedicated git worktree for this ticket. Keep changes focused on the ticket." : "",
    extra ? `\n## Instructions\n${extra}` : ""
  ]
    .filter(Boolean)
    .join("\n")

/**
 * First prompt of a session. Board tickets get the ticket brief; a thread is a plain
 * conversation, so the user's own words go to the agent unchanged.
 */
export const firstPrompt = (ticket: Ticket, extra: string | undefined, inWorktree: boolean) =>
  ticket.tracked ? buildTicketPrompt(ticket, extra, inWorktree) : extra?.trim() || ticket.description || ticket.title

export const SessionsLive = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const { use } = yield* Database
    const events = yield* EventLog
    const harnesses = yield* Harnesses
    const defaults = yield* HarnessSettings
    const approvals = yield* Approvals
    const attachments = yield* Attachments

    /** Attachments for a prompt: references for the event log, bytes and paths for the harness. */
    const loadImages = (ids: ReadonlyArray<string> | undefined) =>
      Effect.gen(function* () {
        if (!ids?.length) return { refs: [] as Array<ImageRef>, prompt: [] as Array<PromptImage> }
        const prompt = yield* attachments.forPrompt(ids)
        const refs = yield* Effect.forEach(ids, (id) =>
          attachments.read(id).pipe(Effect.map((a): ImageRef => ({ id, mimeType: a.mimeType, size: a.bytes.byteLength })))
        )
        return { refs, prompt }
      })
    const notices = yield* Notices
    const limits = yield* Limits
    const activity = yield* Activity
    const tickets = yield* Tickets
    const projects = yield* Projects
    const workspaces = yield* Workspaces
    const config = yield* DaemonConfig
    const layerScope = yield* Effect.scope
    // All session processes and consumer fibers live in this child scope. The shutdown finalizer
    // below is registered on the parent *after* it, so it runs first and can record state.
    const rootScope = yield* Scope.fork(layerScope)
    // One supervised consumer fiber per live session, keyed by session id. Completed fibers
    // remove themselves; closing the scope interrupts any that remain.
    const consumers = yield* FiberMap.make<string>().pipe(Scope.provide(rootScope))
    /** Sessions still running their worktree's setup script, keyed by session id. */
    const booting = yield* FiberMap.make<string>().pipe(Scope.provide(rootScope))
    const withProcesses = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner)
    const live = new Map<string, LiveSession>()
    /** Status line of live sessions; dropped when the process ends. */
    const details = new Map<string, string>()
    /** Latest preview text per session. The daemon is the only writer, so this cache stays exact. */
    const previews = new Map<string, string | null>()
    /**
     * Serializes a turn's end with the next prompt, so a client that saw the session go idle
     * (or saw `turn.completed`) and prompts at once can't interleave with the end of that turn.
     */
    const turnLocks = new Map<string, Semaphore.Semaphore>()
    const turnLock = (id: string) => {
      let lock = turnLocks.get(id)
      if (!lock) turnLocks.set(id, (lock = Semaphore.makeUnsafe(1)))
      return lock
    }
    let shuttingDown = false

    /** Plan progress and usage totals per session; loaded from the log on first use, then kept current by `record`. */
    const plans = new Map<string, SessionPlan | null>()
    const usages = new Map<string, SessionUsage | null>()
    const loadExtras = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const missingPlans = ids.filter((id) => !plans.has(id))
        const missingUsage = ids.filter((id) => !usages.has(id))
        if (missingPlans.length) {
          const found = yield* events.plans(missingPlans)
          for (const id of missingPlans) plans.set(id, found.get(id) ?? null)
        }
        if (missingUsage.length) {
          const found = yield* events.usage(missingUsage)
          for (const id of missingUsage) usages.set(id, found.get(id) ?? null)
        }
      })

    const toSession = (r: Row, lastEventId = 0, preview: string | null = null): AgentSession => ({
      id: r.id,
      ticketId: r.ticketId,
      runId: r.runId,
      stepRunId: r.stepRunId,
      harness: r.harness as HarnessId,
      providerSessionId: r.providerSessionId,
      state: r.state as SessionState,
      cwd: r.cwd,
      pid: r.pid,
      lastEventId,
      statusDetail: (LIVE_STATES.includes(r.state as SessionState) && details.get(r.id)) || null,
      preview,
      plan: plans.get(r.id) ?? null,
      usage: usages.get(r.id) ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    })

    const getRow = (id: string) =>
      use((db) => db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()).pipe(
        Effect.flatMap((r) => (r ? Effect.succeed(r) : Effect.fail(new NotFound({ entity: "session", id }))))
      )

    const previewOf = (id: string) =>
      previews.has(id)
        ? Effect.succeed(previews.get(id) ?? null)
        : events.preview(id).pipe(Effect.tap((p) => Effect.sync(() => previews.set(id, p))))

    const snapshot = (r: Row) =>
      Effect.gen(function* () {
        yield* loadExtras([r.id])
        return toSession(r, yield* events.lastEventId(r.id), yield* previewOf(r.id))
      })

    const get = (id: string) => getRow(id).pipe(Effect.flatMap(snapshot))

    /** Push the whole session with the notice: clients apply it in place instead of refetching. */
    const publishRow = (r: Row) =>
      snapshot(r).pipe(
        Effect.flatMap((session) => notices.publish({ topic: "sessions", sessionId: r.id, ticketId: r.ticketId, session }))
      )

    const setState = (id: string, state: SessionState, extra: Partial<Row> = {}, opts: { notify?: boolean } = {}) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso
        if (!LIVE_STATES.includes(state)) details.delete(id)
        const row = yield* use((db) =>
          db.update(agentSessions).set({ state, updatedAt, ...extra }).where(eq(agentSessions.id, id)).returning().get()
        )
        if (!row) return
        if (opts.notify !== false) yield* publishRow(row)
        yield* notices.publish({ topic: "tickets", ticketId: row.ticketId })
      })

    /**
     * Append an event and keep the session's status line and preview current. Publishes one
     * session notice when either changed (or `force`): token deltas only count when they change
     * the line ("Writing a reply"), so streaming stays quiet. Works on the stored, redacted event.
     */
    const record = (sessionId: string, event: AgentEvent, force = false) =>
      Effect.gen(function* () {
        const stored = yield* events.append(sessionId, event)
        let changed = force
        const detail = describeEvent(stored.event)
        if (detail !== undefined && details.get(sessionId) !== detail) {
          details.set(sessionId, detail)
          changed = true
        }
        const preview = previewText(stored.event)
        if (preview !== null) {
          previews.set(sessionId, preview)
          changed = true
        }
        if (stored.event.type === "plan.updated") {
          plans.set(sessionId, planSummary(stored.event.items))
          changed = true
        }
        // A cached total adds the turn; an unloaded one is read from the log, which already has it.
        if (stored.event.type === "turn.completed" && usages.has(sessionId)) {
          usages.set(sessionId, addTurnUsage(usages.get(sessionId), stored.event) ?? null)
        }
        if (changed) yield* getRow(sessionId).pipe(Effect.flatMap(publishRow), Effect.catchTag("NotFound", () => Effect.void))
        return stored
      })

    /**
     * In progress → In review when the agent's turn left changes in its worktree.
     * Manual Blocked/Done and untouched worktrees (questions, analysis) are left alone.
     */
    const readyForReview = (sessionId: string, ticketId: string) =>
      Effect.gen(function* () {
        const ticket = yield* tickets.get(ticketId)
        if (ticket.status !== "in_progress") return
        const row = yield* getRow(sessionId)
        if (!row.workspaceId) return
        const diff = yield* workspaces.diff(row.workspaceId)
        if (diff.files.length === 0 && diff.commits.length === 0) return
        yield* tickets.update(ticketId, { status: "in_review" }, "system")
      }).pipe(Effect.catch((e) => Effect.logWarning("ready-for-review check failed", e)))

    /** A follow-up means the agent is working again: In review → In progress. */
    const backToWork = (ticketId: string) =>
      tickets.get(ticketId).pipe(
        Effect.flatMap((t) => (t.status === "in_review" ? tickets.update(ticketId, { status: "in_progress" }, "system") : Effect.void)),
        Effect.catch((e) => Effect.logWarning("status update failed", e))
      )

    const onEvent = (sessionId: string, ticketId: string, runId: string | null, stepRunId: string | null, raw: AgentEvent) =>
      Effect.gen(function* () {
        let event = raw
        switch (raw.type) {
          case "session.started":
            if (raw.providerSessionId) {
              yield* use((db) =>
                db.update(agentSessions).set({ providerSessionId: raw.providerSessionId }).where(eq(agentSessions.id, sessionId)).run()
              )
            }
            break
          case "image": {
            // Store the image; the event log keeps only a reference, never base64.
            if (!raw.source) break
            const cwd = yield* getRow(sessionId).pipe(
              Effect.map((r) => r.cwd),
              Effect.orElseSucceed(() => process.cwd())
            )
            const stored = yield* attachments.fromSource(raw.source, cwd).pipe(Effect.option)
            event = Option.isSome(stored)
              ? { type: "image", ...(raw.toolCallId && { toolCallId: raw.toolCallId }), image: stored.value }
              : { type: "session.status", state: "image_unavailable", detail: raw.source.path ?? "The agent produced an image that could not be stored" }
            break
          }
          case "rate_limit": {
            // Account-wide, not part of the conversation: kept per harness, never in the transcript.
            const l = live.get(sessionId)
            if (l) yield* limits.update(l.harness, raw)
            return
          }
          case "approval.requested": {
            const approval = yield* approvals.create({
              ticketId,
              kind: raw.kind === "question" ? "question" : "tool",
              title: raw.summary,
              details: {
                toolName: raw.toolName,
                ...(typeof raw.details === "object" && raw.details ? raw.details : { details: raw.details }),
                ...(raw.questions && { questions: raw.questions }),
                ...(raw.canAllowForSession && { canAllowForSession: true })
              },
              sessionId,
              runId,
              stepRunId,
              providerRequestId: raw.providerRequestId ?? raw.approvalId
            })
            event = { ...raw, approvalId: approval.id }
            yield* setState(sessionId, "waiting_for_approval", {}, { notify: false })
            break
          }
          case "turn.completed":
            if (raw.providerSessionId) {
              yield* use((db) =>
                db.update(agentSessions).set({ providerSessionId: raw.providerSessionId }).where(eq(agentSessions.id, sessionId)).run()
              )
            }
            // Post-turn work, then the event, then the state: whoever sees "idle" or the turn's end
            // also sees its effects, and a prompt sent in reaction can't interleave (see turnLock).
            yield* Effect.gen(function* () {
              // Ad-hoc work that produced changes is ready for review; workflows manage their own status.
              if (!runId && (raw.status ?? "success") === "success") yield* readyForReview(sessionId, ticketId)
              yield* record(sessionId, raw)
              yield* setState(sessionId, "idle")
            }).pipe(Semaphore.withPermit(turnLock(sessionId)))
            return
          case "session.exited": {
            const l = live.get(sessionId)
            if (l) l.exitCode = raw.code ?? null
            break
          }
        }
        // approval.requested changed the state quietly above: always notify.
        yield* record(sessionId, event, event.type === "approval.requested")
      })

    const finish = (sessionId: string, ticketId: string, l: LiveSession) =>
      Effect.gen(function* () {
        live.delete(sessionId)
        turnLocks.delete(sessionId)
        yield* Scope.close(l.scope, Exit.void)
        if (l.lockHolder && l.workspaceId) yield* workspaces.unlock(l.workspaceId, l.lockHolder)
        if (shuttingDown || l.restarting) return
        const expired = yield* approvals.expireForSession(sessionId)
        const row = yield* getRow(sessionId).pipe(Effect.option)
        const current = Option.isSome(row) ? (row.value.state as SessionState) : "closed"
        if (current === "interrupted") return
        const state: SessionState = l.stopping
          ? "closed"
          : l.exitCode === 0 || l.exitCode === undefined || l.exitCode === null
            ? "completed"
            : "failed"
        yield* setState(sessionId, state, { pid: null })
        yield* activity.record({
          kind: "session.ended",
          message: `Agent session ${state}${expired ? ` (${expired} pending approval(s) expired)` : ""}`,
          ticketId
        })
      }).pipe(Effect.catch((e) => Effect.logError("session finish failed", e)))

    /** Launch (or resume) the harness process for an existing session row. */
    const launch = Effect.fn("Sessions.launch")(function* (
      row: Row,
      opts: {
        prompt?: string
        images?: ReadonlyArray<PromptImage>
        resume: boolean
        policy: RunPolicy
        lockHolder?: string
      }
    ) {
        yield* Effect.annotateCurrentSpan({
          sessionId: row.id,
          ticketId: row.ticketId,
          runId: row.runId ?? "",
          harness: row.harness,
          resume: opts.resume,
          permissionMode: opts.policy.permissionMode,
          sandboxed: !!opts.policy.sandboxPrefix
        })
        const adapter = yield* harnesses.get(row.harness as HarnessId)
        // Show what the agent really runs with: ticket, project and harness defaults all feed into it.
        yield* record(row.id, { type: "session.status", state: "permissions", detail: opts.policy.permissionMode })
        const scope = yield* Scope.fork(rootScope)
        // The agent learns which session it is; `agentdesk` refuses approval decisions from inside one.
        const policy = { ...opts.policy, env: { ...opts.policy.env, AGENTDESK_SESSION_ID: row.id } }
        const startInput = { cwd: row.cwd, policy, prompt: opts.prompt, images: opts.images }
        const handle = yield* (opts.resume && row.providerSessionId && adapter.resume
          ? adapter.resume({ ...startInput, providerSessionId: row.providerSessionId })
          : adapter.start(startInput)
        ).pipe(
          Scope.provide(scope),
          withProcesses,
          Effect.withSpan("Harness.start", { attributes: { harness: row.harness, cwd: row.cwd } }),
          Effect.tapError(() => Scope.close(scope, Exit.void))
        )
        const l: LiveSession = {
          handle,
          scope,
          harness: row.harness as HarnessId,
          lockHolder: opts.lockHolder,
          workspaceId: row.workspaceId,
          stopping: false,
          restarting: false,
          exitCode: undefined
        }
        live.set(row.id, l)
        yield* setState(row.id, "running", { pid: handle.pid ?? null })
        yield* handle.events.pipe(
          Stream.runForEach((e) => onEvent(row.id, row.ticketId, row.runId, row.stepRunId, e)),
          Effect.catchTag("HarnessError", (e) => record(row.id, { type: "session.error", message: e.message })),
          Effect.ensuring(finish(row.id, row.ticketId, l)),
          // A long-lived span covering the whole process lifetime of this agent session.
          Effect.withSpan("AgentSession", {
            root: false,
            attributes: { sessionId: row.id, ticketId: row.ticketId, harness: row.harness, pid: handle.pid ?? -1 }
          }),
          FiberMap.run(consumers, row.id, { startImmediately: true })
        )
        return l
      })

    /** Run the worktree's setup script as part of the session, shown like a tool call. Fails the boot on error. */
    const setUp = (sessionId: string, ws: Workspace, project: Project, command: string) =>
      Effect.gen(function* () {
        const toolCallId = "agentdesk-setup"
        yield* record(sessionId, { type: "tool.started", toolCallId, name: "Setup script", input: { command } })
        const r = yield* workspaces.runSetup(ws, project, command)
        const outcome = r.exitCode === null ? "timed out" : `exited with code ${r.exitCode}`
        yield* record(sessionId, {
          type: "tool.completed",
          toolCallId,
          result: `${r.output ? `${r.output}\n\n` : ""}[${outcome} after ${(r.durationMs / 1000).toFixed(1)}s]`,
          isError: !r.ok
        })
        if (!r.ok) {
          return yield* new BadRequest({
            message: `The project's setup script ${outcome}. Fix the script in the project settings, then start the agent again.`
          })
        }
      })

    /** A session stopped while booting: close the agent if it got as far as starting, else just end the session. */
    const cancelBoot = (id: string, release: Effect.Effect<void, DbError>) =>
      Effect.gen(function* () {
        const l = live.get(id)
        if (l) {
          l.stopping = true
          return yield* Scope.close(l.scope, Exit.void)
        }
        yield* setState(id, "closed")
        yield* release
      }).pipe(Effect.catch((e) => Effect.logWarning("could not cancel a booting session", e)))

    const start = Effect.fn("Sessions.start")(function* (input: StartSessionInput) {
        if (!existsSync(input.cwd)) return yield* new BadRequest({ message: `Working directory missing: ${input.cwd}` })
        const id = newId()
        const now = yield* nowIso
        yield* Effect.annotateCurrentSpan({ sessionId: id, ticketId: input.ticketId, runId: input.runId ?? "", harness: input.harness })
        const row: Row = {
          id,
          ticketId: input.ticketId,
          runId: input.runId ?? null,
          stepRunId: input.stepRunId ?? null,
          workspaceId: input.workspaceId ?? null,
          harness: input.harness,
          providerSessionId: null,
          runnerInstance: String(process.pid),
          state: "starting",
          cwd: input.cwd,
          pid: null,
          createdAt: now,
          updatedAt: now
        }
        // Ad-hoc sessions hold the worktree's single-writer lock; workflow runs hold it themselves.
        const lockHolder = input.workspaceId && !input.runId ? id : undefined
        if (lockHolder && input.workspaceId) yield* workspaces.lock(input.workspaceId, lockHolder)
        yield* use((db) => db.insert(agentSessions).values(row).run())
        const images = yield* loadImages(input.images)
        if (input.prompt) yield* record(id, { type: "user.prompt", text: input.prompt, ...(images.refs.length && { images: images.refs }) })
        const release = lockHolder && input.workspaceId ? workspaces.unlock(input.workspaceId, lockHolder) : Effect.void
        const setupCommand = input.setup && pendingSetup(input.setup.workspace, input.setup.project)
        const boot = Effect.gen(function* () {
          if (input.setup && setupCommand) yield* setUp(id, input.setup.workspace, input.setup.project, setupCommand)
          // Never interrupted halfway: a stop during launch then closes the started process (see `cancelBoot`).
          yield* launch(row, { prompt: input.prompt, images: images.prompt, resume: false, policy: input.policy, lockHolder }).pipe(
            Effect.uninterruptible
          )
        }).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* record(id, { type: "session.error", message: e.message })
              yield* setState(id, "failed")
              yield* release
            })
          )
        )
        if (setupCommand) {
          // A setup script can take minutes: answer now and boot in the background. The
          // transcript and status line show the script running; a failure fails the session.
          yield* FiberMap.run(booting, id, boot.pipe(Effect.onInterrupt(() => cancelBoot(id, release)), Effect.ignore))
        } else {
          yield* boot
        }
        yield* activity.record({
          kind: "session.started",
          message: `Started ${input.harness} agent session`,
          ticketId: input.ticketId,
          runId: input.runId ?? null,
          data: { sessionId: id, cwd: input.cwd }
        })
        return yield* get(id)
      })

    const startForTicket = Effect.fn("Sessions.startForTicket")(function* (ticketId: string, input: StartForTicketInput) {
        yield* Effect.annotateCurrentSpan({ ticketId })
        const ticket = yield* tickets.get(ticketId)
        if (ticket.activeSessionId && live.has(ticket.activeSessionId)) {
          return yield* new BadRequest({ message: "This ticket already has an active agent session" })
        }
        const project = yield* projects.forTicket(ticket)
        const harness = input.harness ?? ticket.harness ?? project.defaultHarness
        const policy = yield* projectPolicy(project, config.sandboxPrefix, ticketModel(ticket, project, harness), (yield* defaults.get).harnesses[harness], ticketEffort(ticket, project, harness), ticket.permissionMode)
        // Every agent works in its own worktree, never in the project's main checkout.
        const ws = yield* workspaces.forTicket({
          project,
          ticketId,
          ticketIdentifier: ticket.identifier,
          ticketTitle: ticket.title
        })
        if (ticket.status === "todo") yield* tickets.update(ticketId, { status: "in_progress" }, "system")
        return yield* start({
          ticketId,
          harness,
          cwd: ws.path,
          workspaceId: ws.id,
          policy,
          prompt: firstPrompt(ticket, input.prompt, true),
          images: input.images,
          setup: { workspace: ws, project }
        })
      })

    /**
     * Model and effort switches from the composer. They stick: the ticket remembers them when the
     * session runs the ticket's own harness, so resumes and new sessions use them too. The permission
     * mode means the same to every harness, so the ticket always remembers it.
     */
    const applySwitches = (row: Row, switches: PromptSwitches) =>
      Effect.gen(function* () {
        const ticket = yield* tickets.get(row.ticketId)
        const project = yield* projects.forTicket(ticket)
        const own = row.harness === (ticket.harness ?? project.defaultHarness)
        const update = {
          ...(switches.model !== undefined && switches.model !== ticket.model && { model: switches.model }),
          ...(switches.effort !== undefined && switches.effort !== ticket.effort && { effort: switches.effort })
        }
        if (own && Object.keys(update).length > 0) yield* tickets.update(ticket.id, update, "user")
        if (switches.permissionMode !== undefined && switches.permissionMode !== ticket.permissionMode) {
          yield* tickets.update(ticket.id, { permissionMode: switches.permissionMode }, "user")
        }
        // The relaunch that applies a permission switch records the new mode ("permissions").
        if (switches.model !== undefined) {
          yield* record(row.id, { type: "session.status", state: "model_changed", detail: switches.model ?? "harness default" })
        }
        if (switches.effort !== undefined) {
          yield* record(row.id, { type: "session.status", state: "effort_changed", detail: switches.effort ?? "model default" })
        }
      })

    /** Stop a live process so it can be resumed with new launch settings; resolves once it is gone. */
    const stopForRelaunch = (id: string, l: LiveSession) =>
      Effect.gen(function* () {
        l.restarting = true
        l.stopping = true
        yield* Scope.close(l.scope, Exit.void)
        for (let i = 0; i < 200 && live.has(id); i++) yield* Effect.sleep("50 millis")
      })

    const prompt = Effect.fn("Sessions.prompt")(function* (
      id: string,
      text: string,
      actor = "user",
      imageIds?: ReadonlyArray<string>,
      switches: PromptSwitches = {}
    ) {
        let l = live.get(id)
        yield* Effect.annotateCurrentSpan({
          sessionId: id,
          live: !!l,
          chars: text.length,
          images: imageIds?.length ?? 0,
          model: switches.model ?? "",
          effort: switches.effort ?? "",
          permissionMode: switches.permissionMode ?? ""
        })
        const images = yield* loadImages(imageIds)
        const promptEvent = { type: "user.prompt" as const, text, ...(images.refs.length && { images: images.refs }) }
        const sessionRow = yield* getRow(id)
        if (!sessionRow.runId) yield* backToWork(sessionRow.ticketId)
        if (switches.permissionMode !== undefined) {
          // Refuse before anything changes: a relaunch that then fails would leave the agent stopped.
          const ticket = yield* tickets.get(sessionRow.ticketId)
          const project = yield* projects.forTicket(ticket)
          const harnessDefaults = (yield* defaults.get).harnesses[sessionRow.harness as HarnessId]
          if (effectivePermissionMode(project, harnessDefaults, switches.permissionMode) === "unrestricted" && !config.sandboxPrefix?.length) {
            return yield* unrestrictedWithoutSandbox()
          }
          if (l && !sessionRow.providerSessionId) {
            return yield* new BadRequest({ message: "The agent has not started its conversation yet; change the permission mode once it has" })
          }
        }
        if (switches.model !== undefined || switches.effort !== undefined || switches.permissionMode !== undefined) {
          yield* applySwitches(sessionRow, switches)
        }
        // Permissions are fixed at launch for every harness, and effort is for some (Claude): continue the
        // same conversation in a new process with the new settings.
        const relaunch = switches.permissionMode !== undefined || (switches.effort !== undefined && l?.handle.liveEffort === false)
        if (l && relaunch && sessionRow.providerSessionId) {
          yield* stopForRelaunch(id, l)
          l = live.get(id)
        }
        if (l) {
          const handle = l.handle
          // "Default" on a live process means the configured harness default, if there is one.
          const harnessDefaults = (yield* defaults.get).harnesses[l.harness]
          const liveModel = switches.model === null ? harnessDefaults?.model : switches.model
          const liveEffort = switches.effort ?? undefined
          yield* Effect.gen(function* () {
            yield* record(id, promptEvent)
            yield* setState(id, "running")
            yield* handle.prompt(text, images.prompt, {
              ...(liveModel && { model: liveModel }),
              ...(liveEffort && { effort: liveEffort })
            })
          }).pipe(Semaphore.withPermit(turnLock(id)))
          return
        }
        if (FiberMap.hasUnsafe(booting, id)) {
          return yield* new BadRequest({ message: "The agent is still being set up; send this once it has started" })
        }
        const row = yield* getRow(id)
        if (!row.workspaceId && !row.runId) {
          // Read-only threads (removed) ran in the main checkout. Their conversation can't move to a worktree.
          return yield* new BadRequest({
            message: "This conversation ran in the project's main checkout, which AgentDesk no longer does. Start a new session: it gets its own worktree."
          })
        }
        if (!row.providerSessionId) {
          return yield* new BadRequest({ message: "Session has ended and cannot be resumed (no provider session id)" })
        }
        if (row.workspaceId && !row.runId) yield* workspaces.lock(row.workspaceId, id)
        const ticket = yield* tickets.get(row.ticketId)
        const project = yield* projects.forTicket(ticket)
        yield* record(id, promptEvent)
        yield* record(id, { type: "session.status", state: "resuming", detail: "Resuming provider conversation in a new process" })
        const harness = row.harness as HarnessId
        const basePolicy = yield* projectPolicy(project, config.sandboxPrefix, ticketModel(ticket, project, harness), (yield* defaults.get).harnesses[harness], ticketEffort(ticket, project, harness), ticket.permissionMode)
        // An explicit switch wins over the ticket's settings (it may be for another harness than the ticket's);
        // "default" is already reflected in basePolicy (the ticket's value was cleared).
        const { effort: _ticketEffort, ...withoutEffort } = basePolicy
        const policy = {
          ...(switches.effort === null ? withoutEffort : basePolicy),
          ...(switches.model && { model: switches.model }),
          ...(switches.effort && { effort: switches.effort })
        }
        yield* launch(row, {
          prompt: text,
          images: images.prompt,
          resume: true,
          policy,
          lockHolder: row.workspaceId && !row.runId ? id : undefined
        })
        yield* activity.record({ kind: "session.resumed", message: "Agent session resumed with a follow-up", ticketId: row.ticketId, actor })
      })

    const requireLive = (id: string) =>
      Effect.suspend(() => {
        const l = live.get(id)
        return l ? Effect.succeed(l) : Effect.fail(new BadRequest({ message: "Session is not running" }))
      })

    const interrupt = (id: string) =>
      requireLive(id).pipe(
        Effect.flatMap((l) => l.handle.interrupt),
        Effect.andThen(record(id, { type: "session.status", state: "interrupt_requested" })),
        Effect.asVoid,
        Effect.withSpan("Sessions.interrupt", { attributes: { sessionId: id } })
      )

    const stop = Effect.fn("Sessions.stop")(function* (id: string) {
        yield* Effect.annotateCurrentSpan({ sessionId: id })
        if (FiberMap.hasUnsafe(booting, id)) {
          yield* record(id, { type: "session.status", state: "stopping", detail: "Stopped by user" })
          return yield* FiberMap.remove(booting, id)
        }
        const l = live.get(id)
        if (!l) {
          const row = yield* getRow(id)
          if (LIVE_STATES.includes(row.state as SessionState)) yield* setState(id, "closed")
          return
        }
        l.stopping = true
        yield* record(id, { type: "session.status", state: "stopping", detail: "Stopped by user" })
        yield* Scope.close(l.scope, Exit.void)
      })

    const resolveApproval = Effect.fn("Sessions.resolveApproval")(function* (
      approvalId: string,
      decision: ApprovalDecision,
      actor: string,
      note?: string,
      options: { readonly scope?: "once" | "session"; readonly answers?: QuestionAnswers } = {}
    ) {
        const pending = yield* approvals.get(approvalId)
        const details = (pending.details ?? {}) as { questions?: ReadonlyArray<{ id: string; question: string }>; canAllowForSession?: boolean }
        const isQuestion = pending.kind === "question"
        const answers = isQuestion && decision === "allow" ? options.answers ?? {} : undefined
        if (answers && (details.questions ?? []).some((q) => !(answers[q.id] ?? []).some((a) => a.trim()))) {
          return yield* new BadRequest({ message: "Answer every question, or decline to answer" })
        }
        const scope = !isQuestion && decision === "allow" && options.scope === "session" && details.canAllowForSession ? "session" : "once"
        // Answers are kept as the decision's note, so the audit trail shows what the user chose.
        const answerNote = answers
          ? (details.questions ?? []).map((q) => `${q.question} → ${(answers[q.id] ?? []).join(", ")}`).join("\n")
          : undefined
        const approval = yield* approvals.record(approvalId, decision, actor, note ?? answerNote)
        yield* Effect.annotateCurrentSpan({ sessionId: approval.sessionId ?? "", ticketId: approval.ticketId, scope })
        if (!approval.sessionId) return
        const l = live.get(approval.sessionId)
        if (l && approval.providerRequestId) {
          yield* l.handle.respondToApproval(approval.providerRequestId, {
            decision,
            ...(note && { note }),
            ...(scope === "session" && { scope }),
            ...(answers && { answers })
          })
          yield* setState(approval.sessionId, "running")
        }
        yield* record(approval.sessionId, {
          type: "approval.resolved",
          approvalId,
          decision,
          ...(scope === "session" && { scope }),
          ...(answers && { answers })
        })
        yield* activity.record({
          kind: "approval.decided",
          message: isQuestion
            ? decision === "allow"
              ? `Answered: ${approval.title}`
              : `Declined to answer: ${approval.title}`
            : `${decision === "allow" ? (scope === "session" ? "Approved for the session" : "Approved") : "Denied"}: ${approval.title}`,
          ticketId: approval.ticketId,
          runId: approval.runId,
          actor
        })
      })

    const awaitTurn = Effect.fn("Sessions.awaitTurn")(function* (id: string, afterEventId: number) {
        yield* Effect.annotateCurrentSpan({ sessionId: id })
        const texts: Array<string> = []
        let result: TurnResult | undefined
        yield* events.subscribe(id, afterEventId).pipe(
          Stream.tap((s) =>
            Effect.sync(() => {
              const e = s.event
              if (e.type === "message.completed") texts.push(e.text)
              if (e.type === "turn.completed") {
                result = { status: e.status ?? "success", text: texts.join("\n\n"), lastEventId: s.id }
              }
              if (e.type === "session.exited") result = { status: "exited", text: texts.join("\n\n"), lastEventId: s.id }
            })
          ),
          Stream.takeUntil(() => result !== undefined),
          Stream.runDrain
        )
        const turn = result ?? { status: "exited" as const, text: texts.join("\n\n"), lastEventId: afterEventId }
        yield* Effect.annotateCurrentSpan({ turnStatus: turn.status })
        return turn
      })

    /**
     * A conversation the user drives (not a workflow step) with a provider id survives a daemon
     * restart: it simply waits for a follow-up, which resumes it in a new process. Workflow steps
     * stay "interrupted" so their run can recover them.
     */
    const dormant = (row: { readonly runId: string | null; readonly providerSessionId: string | null }) => !row.runId && !!row.providerSessionId
    const turnCutShort = {
      type: "session.status" as const,
      state: "restarted",
      detail: "AgentDesk restarted during this turn. Send a follow-up to continue the conversation."
    }

    const reconcile = Effect.gen(function* () {
      const updatedAt = yield* nowIso
      const stale = yield* use((db) =>
        db.select().from(agentSessions).where(inArray(agentSessions.state, [...LIVE_STATES])).all()
      )
      for (const s of stale) {
        if (live.has(s.id)) continue
        // A detached harness may have survived the previous daemon. Its stdio is gone, so it can't be
        // re-attached; terminate it if the pid still belongs to the same harness binary.
        if (s.pid) {
          const ps = yield* withProcesses(runCommand("ps", ["-o", "command=", "-p", String(s.pid)], { timeoutMs: 3000 }))
          if (ps.code === 0 && ps.stdout.includes(s.harness)) {
            yield* Effect.sync(() => {
              try {
                process.kill(-s.pid!, "SIGTERM")
              } catch {
                /* gone */
              }
            })
          }
        }
        if (s.workspaceId) yield* workspaces.unlock(s.workspaceId, s.id)
        yield* approvals.expireForSession(s.id)
        if (dormant(s)) {
          // The conversation outlives the process: it waits for a follow-up, which resumes it.
          yield* use((db) => db.update(agentSessions).set({ state: "idle", pid: null, updatedAt }).where(eq(agentSessions.id, s.id)).run())
          if (s.state !== "idle") yield* record(s.id, turnCutShort)
          continue
        }
        yield* use((db) =>
          db.update(agentSessions).set({ state: "interrupted", pid: null, updatedAt }).where(eq(agentSessions.id, s.id)).run()
        )
        yield* record(s.id, {
          type: "session.status",
          state: "interrupted",
          detail: s.providerSessionId
            ? "The daemon restarted. Send a follow-up to resume the conversation in a new process."
            : "The daemon restarted before the agent reported a session id."
        })
        yield* activity.record({ kind: "session.interrupted", message: "Agent session interrupted by daemon restart", ticketId: s.ticketId })
      }
      yield* Effect.annotateCurrentSpan({ reconciled: stale.length })
      return stale.length
    }).pipe(Effect.withSpan("Sessions.reconcile"))

    // Graceful shutdown: mark live sessions interrupted before their scopes close.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        shuttingDown = true
      }).pipe(Effect.andThen(Effect.forEach([...live.entries()], ([id, l]) =>
        Effect.gen(function* () {
          l.stopping = true
          const updatedAt = yield* nowIso
          const row = yield* getRow(id)
          if (dormant(row)) {
            // Nothing to report for a conversation at rest; one cut mid-turn says so, without alarm.
            yield* use((db) => db.update(agentSessions).set({ state: "idle", pid: null, updatedAt }).where(eq(agentSessions.id, id)).run())
            if (row.state !== "idle") yield* events.append(id, turnCutShort)
            return
          }
          yield* use((db) =>
            db.update(agentSessions).set({ state: "interrupted", pid: null, updatedAt }).where(eq(agentSessions.id, id)).run()
          )
          yield* events.append(id, { type: "session.status", state: "interrupted", detail: "Daemon shutting down" })
        }).pipe(Effect.ignore)
      )))
    )

    return Sessions.of({
      start,
      startForTicket,
      get,
      list: ({ ticketId, active, limit }) =>
        Effect.gen(function* () {
          const rows = yield* use((db) =>
            db
              .select()
              .from(agentSessions)
              .where(
                and(
                  ticketId ? eq(agentSessions.ticketId, ticketId) : undefined,
                  active ? inArray(agentSessions.state, [...LIVE_STATES]) : undefined
                )
              )
              .orderBy(desc(agentSessions.createdAt))
              .limit(limit ?? 200)
              .all()
          )
          const lastIds = yield* events.lastEventIds(rows.map((r) => r.id))
          yield* loadExtras(rows.map((r) => r.id))
          return yield* Effect.forEach(rows, (r) =>
            previewOf(r.id).pipe(Effect.map((preview) => toSession(r, lastIds.get(r.id) ?? 0, preview)))
          )
        }),
      prompt,
      interrupt,
      stop,
      resolveApproval,
      awaitTurn,
      isLive: (id) => live.has(id),
      liveCount: () => live.size,
      reconcile
    })
  })
)
