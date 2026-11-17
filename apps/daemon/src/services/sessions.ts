import { existsSync } from "node:fs"
import type {
  ImageRef,
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  HarnessDefaults,
  HarnessId,
  Project,
  SessionState,
  Ticket
} from "@agentdesk/contracts"
import { agentSessions } from "@agentdesk/db"
import type { GitError } from "@agentdesk/git"
import { type HarnessError, type HarnessSession, type PromptImage, type RunPolicy, runCommand } from "@agentdesk/harness-core"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Exit, FiberMap, Layer, Option, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { BadRequest, type Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { DaemonConfig } from "../config"
import { Activity } from "./activity"
import { Approvals } from "./approvals"
import { Attachments } from "./attachments"
import { Database } from "./database"
import { EventLog } from "./event-log"
import { HarnessSettings } from "./harness-settings"
import { Harnesses } from "./harnesses"
import { Notices } from "./notices"
import { Projects } from "./projects"
import { Tickets } from "./tickets"
import { Workspaces } from "./workspaces"

type Row = typeof agentSessions.$inferSelect

export const LIVE_STATES: ReadonlyArray<SessionState> = ["starting", "running", "waiting_for_approval", "idle"]

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
}

export interface StartForTicketInput {
  readonly harness?: HarnessId
  readonly prompt?: string
  readonly useRepoDirectly?: boolean
  readonly images?: ReadonlyArray<string>
}

export interface TurnResult {
  readonly status: "success" | "error" | "interrupted" | "exited"
  /** Concatenated final assistant messages of the turn. */
  readonly text: string
  readonly lastEventId: number
}

type SessionError = NotFound | BadRequest | Conflict | DbError | HarnessError | GitError

export interface SessionsShape {
  readonly start: (input: StartSessionInput) => Effect.Effect<AgentSession, SessionError>
  readonly startForTicket: (ticketId: string, input: StartForTicketInput) => Effect.Effect<AgentSession, SessionError>
  readonly get: (id: string) => Effect.Effect<AgentSession, NotFound | DbError>
  readonly list: (filter: { ticketId?: string; active?: boolean; limit?: number }) => Effect.Effect<ReadonlyArray<AgentSession>, DbError>
  /** Send a follow-up. Transparently resumes the provider conversation if the process is gone. */
  readonly prompt: (id: string, text: string, actor?: string, images?: ReadonlyArray<string>) => Effect.Effect<void, SessionError>
  readonly interrupt: (id: string) => Effect.Effect<void, SessionError>
  /** Terminate the harness process. */
  readonly stop: (id: string) => Effect.Effect<void, SessionError>
  readonly resolveApproval: (
    approvalId: string,
    decision: ApprovalDecision,
    actor: string,
    note?: string
  ) => Effect.Effect<void, SessionError>
  /** Wait until the session's current turn completes (or the process exits). */
  readonly awaitTurn: (id: string, afterEventId: number) => Effect.Effect<TurnResult, DbError>
  readonly isLive: (id: string) => boolean
  readonly liveCount: () => number
  /** Startup reconciliation: sessions left "live" by a previous daemon are marked interrupted. */
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
  exitCode: number | null | undefined
}

/**
 * Build the harness run policy for a project. Unrestricted mode is refused
 * unless a real sandbox is configured: a git worktree is not a sandbox.
 */
export const projectPolicy = (
  project: Project,
  sandboxPrefix: ReadonlyArray<string> | undefined,
  model?: string | null,
  defaults?: HarnessDefaults
) => {
  const permissionMode = project.inheritHarnessPermissions ? defaults?.permissionMode ?? "ask" : project.permissionMode
  return permissionMode === "unrestricted" && !sandboxPrefix?.length
    ? Effect.fail(new BadRequest({ message: "Unrestricted permission mode requires a sandbox (set AGENTDESK_SANDBOX_CMD). Choose another permission mode or configure a sandbox." }))
    : Effect.succeed<RunPolicy>({
        permissionMode,
        ...((model ?? defaults?.model) && { model: (model ?? defaults?.model)! }),
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

export const buildTicketPrompt = (ticket: Ticket, extra?: string) =>
  [
    `You are working on ticket ${ticket.identifier}: ${ticket.title}`,
    ticket.description ? `\n## Description\n${ticket.description}` : "",
    ticket.acceptanceCriteria ? `\n## Acceptance criteria\n${ticket.acceptanceCriteria}` : "",
    "\nYou are running inside a dedicated git worktree for this ticket. Keep changes focused on the ticket.",
    extra ? `\n## Instructions\n${extra}` : ""
  ]
    .filter(Boolean)
    .join("\n")

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
    const withProcesses = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner)
    const live = new Map<string, LiveSession>()
    let shuttingDown = false

    const toSession = (r: Row, lastEventId = 0): AgentSession => ({
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
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    })

    const getRow = (id: string) =>
      use((db) => db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()).pipe(
        Effect.flatMap((r) => (r ? Effect.succeed(r) : Effect.fail(new NotFound({ entity: "session", id }))))
      )

    const get = (id: string) =>
      Effect.gen(function* () {
        const r = yield* getRow(id)
        return toSession(r, yield* events.lastEventId(id))
      })

    const setState = (id: string, state: SessionState, extra: Partial<Row> = {}) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso
        const row = yield* use((db) =>
          db
            .update(agentSessions)
            .set({ state, updatedAt, ...extra })
            .where(eq(agentSessions.id, id))
            .returning({ ticketId: agentSessions.ticketId, runId: agentSessions.runId })
            .get()
        )
        yield* notices.publish({ topic: "sessions", sessionId: id, ticketId: row?.ticketId })
        if (row) yield* notices.publish({ topic: "tickets", ticketId: row.ticketId })
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
          case "approval.requested": {
            const approval = yield* approvals.create({
              ticketId,
              kind: "tool",
              title: raw.summary,
              details: { toolName: raw.toolName, ...(typeof raw.details === "object" && raw.details ? raw.details : { details: raw.details }) },
              sessionId,
              runId,
              stepRunId,
              providerRequestId: raw.providerRequestId ?? raw.approvalId
            })
            event = { ...raw, approvalId: approval.id }
            yield* setState(sessionId, "waiting_for_approval")
            break
          }
          case "turn.completed":
            if (raw.providerSessionId) {
              yield* use((db) =>
                db.update(agentSessions).set({ providerSessionId: raw.providerSessionId }).where(eq(agentSessions.id, sessionId)).run()
              )
            }
            yield* setState(sessionId, "idle")
            // Ad-hoc work that produced changes is ready for review; workflows manage their own status.
            if (!runId && (raw.status ?? "success") === "success") yield* readyForReview(sessionId, ticketId)
            break
          case "session.exited": {
            const l = live.get(sessionId)
            if (l) l.exitCode = raw.code ?? null
            break
          }
        }
        yield* events.append(sessionId, event)
      })

    const finish = (sessionId: string, ticketId: string, l: LiveSession) =>
      Effect.gen(function* () {
        live.delete(sessionId)
        yield* Scope.close(l.scope, Exit.void)
        if (l.lockHolder && l.workspaceId) yield* workspaces.unlock(l.workspaceId, l.lockHolder)
        if (shuttingDown) return
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
      opts: { prompt?: string; images?: ReadonlyArray<PromptImage>; resume: boolean; policy: RunPolicy; lockHolder?: string }
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
        const scope = yield* Scope.fork(rootScope)
        const startInput = { cwd: row.cwd, policy: opts.policy, prompt: opts.prompt, images: opts.images }
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
          exitCode: undefined
        }
        live.set(row.id, l)
        yield* setState(row.id, "running", { pid: handle.pid ?? null })
        yield* handle.events.pipe(
          Stream.runForEach((e) => onEvent(row.id, row.ticketId, row.runId, row.stepRunId, e)),
          Effect.catchTag("HarnessError", (e) => events.append(row.id, { type: "session.error", message: e.message })),
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
        if (input.prompt) yield* events.append(id, { type: "user.prompt", text: input.prompt, ...(images.refs.length && { images: images.refs }) })
        yield* launch(row, { prompt: input.prompt, images: images.prompt, resume: false, policy: input.policy, lockHolder }).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* events.append(id, { type: "session.error", message: e.message })
              yield* setState(id, "failed")
              if (lockHolder && input.workspaceId) yield* workspaces.unlock(input.workspaceId, lockHolder)
            })
          )
        )
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
        const project = yield* projects.get(ticket.projectId)
        const harness = input.harness ?? ticket.harness ?? project.defaultHarness
        const policy = yield* projectPolicy(project, config.sandboxPrefix, ticketModel(ticket, project, harness), (yield* defaults.get).harnesses[harness])
        const ws = input.useRepoDirectly
          ? undefined
          : yield* workspaces.forTicket({
              project,
              ticketId,
              ticketIdentifier: ticket.identifier,
              ticketTitle: ticket.title
            })
        if (ticket.status === "todo") yield* tickets.update(ticketId, { status: "in_progress" }, "system")
        return yield* start({
          ticketId,
          harness,
          cwd: ws?.path ?? project.repoPath,
          workspaceId: ws?.id ?? null,
          policy,
          prompt: buildTicketPrompt(ticket, input.prompt),
          images: input.images
        })
      })

    const prompt = Effect.fn("Sessions.prompt")(function* (id: string, text: string, actor = "user", imageIds?: ReadonlyArray<string>) {
        const l = live.get(id)
        yield* Effect.annotateCurrentSpan({ sessionId: id, live: !!l, chars: text.length, images: imageIds?.length ?? 0 })
        const images = yield* loadImages(imageIds)
        const promptEvent = { type: "user.prompt" as const, text, ...(images.refs.length && { images: images.refs }) }
        const sessionRow = yield* getRow(id)
        if (!sessionRow.runId) yield* backToWork(sessionRow.ticketId)
        if (l) {
          yield* events.append(id, promptEvent)
          yield* setState(id, "running")
          yield* l.handle.prompt(text, images.prompt)
          return
        }
        const row = yield* getRow(id)
        if (!row.providerSessionId) {
          return yield* new BadRequest({ message: "Session has ended and cannot be resumed (no provider session id)" })
        }
        if (row.workspaceId && !row.runId) yield* workspaces.lock(row.workspaceId, id)
        const ticket = yield* tickets.get(row.ticketId)
        const project = yield* projects.get(ticket.projectId)
        yield* events.append(id, promptEvent)
        yield* events.append(id, { type: "session.status", state: "resuming", detail: "Resuming provider conversation in a new process" })
        yield* launch(row, {
          prompt: text,
          images: images.prompt,
          resume: true,
          policy: yield* projectPolicy(project, config.sandboxPrefix, ticketModel(ticket, project, row.harness as HarnessId), (yield* defaults.get).harnesses[row.harness as HarnessId]),
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
        Effect.andThen(events.append(id, { type: "session.status", state: "interrupt_requested" })),
        Effect.asVoid,
        Effect.withSpan("Sessions.interrupt", { attributes: { sessionId: id } })
      )

    const stop = Effect.fn("Sessions.stop")(function* (id: string) {
        yield* Effect.annotateCurrentSpan({ sessionId: id })
        const l = live.get(id)
        if (!l) {
          const row = yield* getRow(id)
          if (LIVE_STATES.includes(row.state as SessionState)) yield* setState(id, "closed")
          return
        }
        l.stopping = true
        yield* events.append(id, { type: "session.status", state: "stopping", detail: "Stopped by user" })
        yield* Scope.close(l.scope, Exit.void)
      })

    const resolveApproval = Effect.fn("Sessions.resolveApproval")(function* (
      approvalId: string,
      decision: ApprovalDecision,
      actor: string,
      note?: string
    ) {
        const approval = yield* approvals.record(approvalId, decision, actor, note)
        yield* Effect.annotateCurrentSpan({ sessionId: approval.sessionId ?? "", ticketId: approval.ticketId })
        if (!approval.sessionId) return
        const l = live.get(approval.sessionId)
        if (l && approval.providerRequestId) {
          yield* l.handle.respondToApproval(approval.providerRequestId, decision, note)
          yield* setState(approval.sessionId, "running")
        }
        yield* events.append(approval.sessionId, { type: "approval.resolved", approvalId, decision })
        yield* activity.record({
          kind: "approval.decided",
          message: `${decision === "allow" ? "Approved" : "Denied"}: ${approval.title}`,
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
        yield* use((db) =>
          db.update(agentSessions).set({ state: "interrupted", pid: null, updatedAt }).where(eq(agentSessions.id, s.id)).run()
        )
        if (s.workspaceId) yield* workspaces.unlock(s.workspaceId, s.id)
        yield* approvals.expireForSession(s.id)
        yield* events.append(s.id, {
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
        use((db) =>
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
            .map((r) => toSession(r))
        ),
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
