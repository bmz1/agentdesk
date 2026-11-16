import type {
  BoardStatus,
  CreateTicketBody,
  ExternalLink,
  RunSummary,
  Ticket,
  TicketSource,
  UpdateTicketBody
} from "@agentdesk/contracts"
import { agentSessions, projects, ticketExternalLinks, tickets, workflowRuns } from "@agentdesk/db"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { BadRequest, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { Database, type DatabaseShape } from "./database"
import { Notices } from "./notices"

export interface TicketFilter {
  readonly projectId?: string
  readonly source?: TicketSource
  readonly status?: BoardStatus
  readonly q?: string
  readonly pinned?: boolean
  readonly ids?: ReadonlyArray<string>
}

export interface TicketsShape {
  readonly list: (filter?: TicketFilter) => Effect.Effect<ReadonlyArray<Ticket>, DbError>
  readonly get: (id: string) => Effect.Effect<Ticket, NotFound | DbError>
  readonly create: (body: CreateTicketBody, actor?: string) => Effect.Effect<Ticket, NotFound | BadRequest | DbError>
  readonly update: (id: string, body: UpdateTicketBody, actor?: string) => Effect.Effect<Ticket, NotFound | BadRequest | DbError>
  readonly remove: (id: string) => Effect.Effect<void, NotFound | BadRequest | DbError>
}

export class Tickets extends Context.Service<Tickets, TicketsShape>()("agentdesk/Tickets") {}

const ACTIVE_SESSION_STATES = ["starting", "running", "waiting_for_approval", "idle"]

/** Build a safe FTS5 query: each token becomes a quoted prefix match. */
export const ftsQuery = (q: string) =>
  q
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(" ")

export const loadTickets = (database: DatabaseShape, filter: TicketFilter = {}) =>
  database.use((db): ReadonlyArray<Ticket> => {
    let idFilter: Array<string> | undefined = filter.ids ? [...filter.ids] : undefined
    if (filter.q?.trim()) {
      const q = filter.q.trim()
      const fts = ftsQuery(q)
      const ftsIds = fts
        ? (database.sqlite
            .prepare(
              "SELECT t.id FROM tickets t JOIN tickets_fts f ON f.rowid = t.rowid WHERE tickets_fts MATCH ? LIMIT 500"
            )
            .all(fts) as Array<{ id: string }>)
        : []
      const keyIds = database.sqlite
        .prepare(
          `SELECT t.id FROM tickets t JOIN projects p ON p.id = t.project_id
           LEFT JOIN ticket_external_links l ON l.ticket_id = t.id
           WHERE upper(l.display_key) LIKE ? OR upper(p.key || '-' || t.number) LIKE ? LIMIT 500`
        )
        .all(`%${q.toUpperCase()}%`, `%${q.toUpperCase()}%`) as Array<{ id: string }>
      const found = new Set([...ftsIds, ...keyIds].map((r) => r.id))
      idFilter = idFilter ? idFilter.filter((id) => found.has(id)) : [...found]
      if (idFilter.length === 0) return []
    }
    const where = and(
      filter.projectId ? eq(tickets.projectId, filter.projectId) : undefined,
      filter.source ? eq(tickets.sourceKind, filter.source) : undefined,
      filter.status ? eq(tickets.status, filter.status) : undefined,
      filter.pinned !== undefined ? eq(tickets.pinned, filter.pinned) : undefined,
      idFilter ? inArray(tickets.id, idFilter) : undefined
    )
    const rows = db
      .select({ t: tickets, projectKey: projects.key, link: ticketExternalLinks })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .leftJoin(ticketExternalLinks, eq(ticketExternalLinks.ticketId, tickets.id))
      .where(where)
      .orderBy(tickets.sortOrder, desc(tickets.updatedAt))
      .all()
    if (rows.length === 0) return []
    const ids = rows.map((r) => r.t.id)

    const latestRuns = new Map<string, RunSummary>()
    for (const run of db
      .select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.ticketId, ids))
      .orderBy(desc(workflowRuns.createdAt))
      .all()) {
      if (latestRuns.has(run.ticketId)) continue
      latestRuns.set(run.ticketId, {
        id: run.id,
        status: run.status as RunSummary["status"],
        activeStepId: run.activeStepId,
        needsInput: run.status === "waiting_for_approval"
      })
    }
    const activeSessions = new Map<string, { id: string; state: string }>()
    for (const s of db
      .select({ id: agentSessions.id, ticketId: agentSessions.ticketId, state: agentSessions.state })
      .from(agentSessions)
      .where(and(inArray(agentSessions.ticketId, ids), inArray(agentSessions.state, ACTIVE_SESSION_STATES)))
      .orderBy(desc(agentSessions.createdAt))
      .all()) {
      if (!activeSessions.has(s.ticketId)) activeSessions.set(s.ticketId, s)
    }

    return rows.map(({ t, projectKey, link }) => {
      const external: ExternalLink | null = link
        ? {
            provider: "jira",
            remoteId: link.remoteId,
            displayKey: link.displayKey,
            url: link.url,
            remoteStatus: link.remoteStatus,
            remoteAssignee: link.remoteAssignee,
            remoteUpdatedAt: link.remoteUpdatedAt,
            remoteState: link.remoteState === "missing" ? "missing" : "active"
          }
        : null
      const session = activeSessions.get(t.id)
      const run = latestRuns.get(t.id) ?? null
      return {
        id: t.id,
        projectId: t.projectId,
        number: t.number,
        identifier: external?.displayKey ?? `${projectKey}-${t.number}`,
        title: t.title,
        description: t.description,
        acceptanceCriteria: t.acceptanceCriteria,
        status: t.status as BoardStatus,
        priority: t.priority as Ticket["priority"],
        source: t.sourceKind as TicketSource,
        harness: (t.harness as Ticket["harness"]) ?? null,
        workflowId: t.workflowId,
        labels: t.labels ?? [],
        pinned: t.pinned,
        sortOrder: t.sortOrder,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        lastActivityAt: t.lastActivityAt,
        external,
        latestRun: run && session?.state === "waiting_for_approval" ? { ...run, needsInput: true } : run,
        activeSessionId: session?.id ?? null
      } satisfies Ticket
    })
  })

/** Allocate the next per-project ticket number atomically. Must run inside a transaction. */
export const nextTicketNumber = (database: DatabaseShape, projectId: string): number => {
  const row = database.sqlite
    .prepare("UPDATE projects SET ticket_counter = ticket_counter + 1 WHERE id = ? RETURNING ticket_counter")
    .get(projectId) as { ticket_counter: number } | undefined
  if (!row) throw new Error(`Project ${projectId} not found`)
  return row.ticket_counter
}

export const TicketsLive = Layer.effect(
  Tickets,
  Effect.gen(function* () {
    const database = yield* Database
    const { use, tx } = database
    const activity = yield* Activity
    const notices = yield* Notices

    const get = (id: string) =>
      loadTickets(database, { ids: [id] }).pipe(
        Effect.flatMap((r) => (r[0] ? Effect.succeed(r[0]) : Effect.fail(new NotFound({ entity: "ticket", id }))))
      )

    const ensureProject = (projectId: string) =>
      use((db) => db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()).pipe(
        Effect.flatMap((p) => (p ? Effect.void : Effect.fail(new NotFound({ entity: "project", id: projectId }))))
      )

    const create = (body: CreateTicketBody, actor = "user") =>
      Effect.gen(function* () {
        yield* ensureProject(body.projectId)
        const id = newId()
        const now = nowIso()
        yield* tx((db) => {
          const number = nextTicketNumber(database, body.projectId)
          const minOrder =
            db
              .select({ m: sql<number>`coalesce(min(${tickets.sortOrder}), 0)` })
              .from(tickets)
              .where(and(eq(tickets.projectId, body.projectId), eq(tickets.status, body.status ?? "todo")))
              .get()?.m ?? 0
          db.insert(tickets)
            .values({
              id,
              projectId: body.projectId,
              number,
              title: body.title.trim(),
              description: body.description ?? "",
              acceptanceCriteria: body.acceptanceCriteria ?? "",
              status: body.status ?? "todo",
              priority: body.priority ?? "none",
              sourceKind: "local",
              harness: body.harness ?? null,
              workflowId: body.workflowId ?? null,
              labels: [...(body.labels ?? [])],
              pinned: false,
              sortOrder: minOrder - 1,
              createdAt: now,
              updatedAt: now,
              lastActivityAt: now
            })
            .run()
        })
        yield* activity.record({ kind: "ticket.created", message: `Created "${body.title}"`, ticketId: id, actor })
        yield* notices.publish({ topic: "tickets", ticketId: id })
        return yield* get(id)
      })

    const update = (id: string, body: UpdateTicketBody, actor = "user") =>
      Effect.gen(function* () {
        const before = yield* get(id)
        if (before.source === "jira" && (body.title !== undefined || body.description !== undefined)) {
          return yield* new BadRequest({ message: "Title and description of Jira tickets are owned by Jira (read-only sync)" })
        }
        if (body.projectId) yield* ensureProject(body.projectId)
        yield* use((db) =>
          db
            .update(tickets)
            .set({
              ...(body.title !== undefined && { title: body.title.trim() }),
              ...(body.description !== undefined && { description: body.description }),
              ...(body.acceptanceCriteria !== undefined && { acceptanceCriteria: body.acceptanceCriteria }),
              ...(body.status !== undefined && { status: body.status }),
              ...(body.priority !== undefined && { priority: body.priority }),
              ...(body.harness !== undefined && { harness: body.harness }),
              ...(body.workflowId !== undefined && { workflowId: body.workflowId }),
              ...(body.labels !== undefined && { labels: [...body.labels] }),
              ...(body.pinned !== undefined && { pinned: body.pinned }),
              ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
              ...(body.projectId !== undefined && { projectId: body.projectId }),
              updatedAt: nowIso()
            })
            .where(eq(tickets.id, id))
            .run()
        )
        if (body.status !== undefined && body.status !== before.status) {
          yield* activity.record({
            kind: "ticket.status",
            message: `Moved from ${before.status} to ${body.status} (local board only)`,
            ticketId: id,
            actor,
            data: { from: before.status, to: body.status }
          })
        } else if (body.title !== undefined || body.description !== undefined || body.priority !== undefined) {
          yield* activity.record({ kind: "ticket.updated", message: "Ticket details updated", ticketId: id, actor })
        }
        yield* notices.publish({ topic: "tickets", ticketId: id })
        return yield* get(id)
      })

    const remove = (id: string) =>
      Effect.gen(function* () {
        const t = yield* get(id)
        if (t.source !== "local") return yield* new BadRequest({ message: "Only local tickets can be deleted" })
        if (t.activeSessionId) return yield* new BadRequest({ message: "Stop the active agent session first" })
        yield* tx((db) => {
          const runIds = db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.ticketId, id)).all()
          if (runIds.length > 0) throw new Error("Ticket has workflow history; archive it (move to Done) instead")
          db.delete(agentSessions).where(eq(agentSessions.ticketId, id)).run()
          db.delete(tickets).where(eq(tickets.id, id)).run()
        }).pipe(Effect.mapError((e) => new BadRequest({ message: e.message })))
        yield* notices.publish({ topic: "tickets", ticketId: id })
      })

    return { list: (f) => loadTickets(database, f), get, create, update, remove } satisfies TicketsShape
  })
)
