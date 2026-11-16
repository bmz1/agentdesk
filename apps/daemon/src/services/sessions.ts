import { existsSync } from "node:fs"
import type {
  AgentEvent,
  AgentSession,
  ApprovalDecision,
  HarnessId,
  SessionState,
  Ticket
} from "@agentdesk/contracts"
import { agentSessions } from "@agentdesk/db"
import type { GitError } from "@agentdesk/git"
import { type HarnessError, type HarnessSession, type RunPolicy, runCommand } from "@agentdesk/harness-core"
import { and, desc, eq, inArray } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Option, Scope, Stream } from "effect"
import { BadRequest, type Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { Approvals } from "./approvals"
import { Database } from "./database"
import { EventLog } from "./event-log"
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
  readonly workspaceId?: string | null
  readonly runId?: string | null
  readonly stepRunId?: string | null
}

export interface StartForTicketInput {
  readonly harness?: HarnessId
  readonly prompt?: string
  readonly useRepoDirectly?: boolean
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
  readonly prompt: (id: string, text: string, actor?: string) => Effect.Effect<void, SessionError>
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
    const approvals = yield* Approvals
    const notices = yield* Notices
    const activity = yield* Activity
    const tickets = yield* Tickets
    const projects = yield* Projects
    const workspaces = yield* Workspaces
    const layerScope = yield* Effect.scope
    // All session processes and consumer fibers live in this child scope. The shutdown finalizer
    // below is registered on the parent *after* it, so it runs first and can record state.
    const rootScope = yield* Scope.fork(layerScope)
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
        const row = yield* use((db) =>
          db
            .update(agentSessions)
            .set({ state, updatedAt: nowIso(), ...extra })
            .where(eq(agentSessions.id, id))
            .returning({ ticketId: agentSessions.ticketId, runId: agentSessions.runId })
            .get()
        )
        yield* notices.publish({ topic: "sessions", sessionId: id, ticketId: row?.ticketId })
        if (row) yield* notices.publish({ topic: "tickets", ticketId: row.ticketId })
      })

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
    const launch = (row: Row, opts: { prompt?: string; resume: boolean; policy: RunPolicy; lockHolder?: string }) =>
      Effect.gen(function* () {
        const adapter = yield* harnesses.get(row.harness as HarnessId)
        const scope = yield* Scope.fork(rootScope)
        const startInput = { cwd: row.cwd, policy: opts.policy, prompt: opts.prompt }
        const handle = yield* (opts.resume && row.providerSessionId && adapter.resume
          ? adapter.resume({ ...startInput, providerSessionId: row.providerSessionId })
          : adapter.start(startInput)
        ).pipe(
          Scope.provide(scope),
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
          Effect.catch((e) =>
            events.append(row.id, { type: "session.error", message: "message" in e ? String(e.message) : String(e) })
          ),
          Effect.ensuring(finish(row.id, row.ticketId, l)),
          Effect.forkIn(rootScope)
        )
        return l
      })

    const start = (input: StartSessionInput) =>
      Effect.gen(function* () {
        if (!existsSync(input.cwd)) return yield* new BadRequest({ message: `Working directory missing: ${input.cwd}` })
        const id = newId()
        const now = nowIso()
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
        if (input.prompt) yield* events.append(id, { type: "user.prompt", text: input.prompt })
        yield* launch(row, { prompt: input.prompt, resume: false, policy: input.policy, lockHolder }).pipe(
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

    const startForTicket = (ticketId: string, input: StartForTicketInput) =>
      Effect.gen(function* () {
        const ticket = yield* tickets.get(ticketId)
        if (ticket.activeSessionId && live.has(ticket.activeSessionId)) {
          return yield* new BadRequest({ message: "This ticket already has an active agent session" })
        }
        const project = yield* projects.get(ticket.projectId)
        const harness = input.harness ?? ticket.harness ?? project.defaultHarness
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
          policy: { permissionMode: project.permissionMode },
          prompt: buildTicketPrompt(ticket, input.prompt)
        })
      })

    const prompt = (id: string, text: string, actor = "user") =>
      Effect.gen(function* () {
        const l = live.get(id)
        if (l) {
          yield* events.append(id, { type: "user.prompt", text })
          yield* setState(id, "running")
          yield* l.handle.prompt(text)
          return
        }
        const row = yield* getRow(id)
        if (!row.providerSessionId) {
          return yield* new BadRequest({ message: "Session has ended and cannot be resumed (no provider session id)" })
        }
        if (row.workspaceId && !row.runId) yield* workspaces.lock(row.workspaceId, id)
        const project = yield* tickets.get(row.ticketId).pipe(Effect.flatMap((t) => projects.get(t.projectId)))
        yield* events.append(id, { type: "user.prompt", text })
        yield* events.append(id, { type: "session.status", state: "resuming", detail: "Resuming provider conversation in a new process" })
        yield* launch(row, {
          prompt: text,
          resume: true,
          policy: { permissionMode: project.permissionMode },
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
        Effect.asVoid
      )

    const stop = (id: string) =>
      Effect.gen(function* () {
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

    const resolveApproval = (approvalId: string, decision: ApprovalDecision, actor: string, note?: string) =>
      Effect.gen(function* () {
        const approval = yield* approvals.record(approvalId, decision, actor, note)
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

    const awaitTurn = (id: string, afterEventId: number) =>
      Effect.gen(function* () {
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
        return result ?? { status: "exited" as const, text: texts.join("\n\n"), lastEventId: afterEventId }
      })

    const reconcile = Effect.gen(function* () {
      const stale = yield* use((db) =>
        db.select().from(agentSessions).where(inArray(agentSessions.state, [...LIVE_STATES])).all()
      )
      for (const s of stale) {
        if (live.has(s.id)) continue
        // A detached harness may have survived the previous daemon. Its stdio is gone, so it can't be
        // re-attached; terminate it if the pid still belongs to the same harness binary.
        if (s.pid) {
          const ps = yield* runCommand("ps", ["-o", "command=", "-p", String(s.pid)], { timeoutMs: 3000 })
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
          db.update(agentSessions).set({ state: "interrupted", pid: null, updatedAt: nowIso() }).where(eq(agentSessions.id, s.id)).run()
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
      return stale.length
    })

    // Graceful shutdown: mark live sessions interrupted before their scopes close.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        shuttingDown = true
      }).pipe(Effect.andThen(Effect.forEach([...live.entries()], ([id, l]) =>
        Effect.gen(function* () {
          l.stopping = true
          yield* use((db) =>
            db.update(agentSessions).set({ state: "interrupted", pid: null, updatedAt: nowIso() }).where(eq(agentSessions.id, id)).run()
          )
          yield* events.append(id, { type: "session.status", state: "interrupted", detail: "Daemon shutting down" })
        }).pipe(Effect.ignore)
      )))
    )

    return {
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
    } satisfies SessionsShape
  })
)
