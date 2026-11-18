import type {
  BoardStatus,
  CreateSourceConnectionBody,
  SourceConnection,
  SourceDescriptor,
  SyncResult,
  UpdateSourceConnectionBody
} from "@agentdesk/contracts"
import { sourceConnections, sourceSyncState, ticketExternalLinks, tickets } from "@agentdesk/db"
import { jiraSource } from "@agentdesk/jira"
import { linearSource } from "@agentdesk/linear"
import {
  type ConnectOptions,
  makeSourceRegistry,
  type RemoteTask,
  type SourceRegistry,
  type TaskSourceAdapter,
  type TaskSourceClient,
  type TaskSourceError
} from "@agentdesk/task-source"
import { and, eq, notInArray } from "drizzle-orm"
import { Clock, Context, Duration, Effect, FiberMap, Layer, Redacted, Schedule, type Schema, Semaphore } from "effect"
import { DaemonConfig } from "../config"
import { type BadRequest, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { CredentialStore } from "./credentials"
import { Database, type DatabaseShape } from "./database"
import { Notices } from "./notices"

// ---------------------------------------------------------------------------------------------
// Registry of available sources (adapters), as an Effect service.
// ---------------------------------------------------------------------------------------------

export interface TaskSourcesShape extends SourceRegistry {}

export class TaskSources extends Context.Service<TaskSources, TaskSourcesShape>()("agentdesk/TaskSources") {}

export const defaultSources = (): ReadonlyArray<TaskSourceAdapter<any>> => [jiraSource, linearSource]

export const TaskSourcesLive = (adapters: ReadonlyArray<TaskSourceAdapter<any>> = defaultSources()) =>
  Layer.succeed(TaskSources, TaskSources.of(makeSourceRegistry(adapters)))

// ---------------------------------------------------------------------------------------------
// Generic, provider-agnostic synchronization.
// ---------------------------------------------------------------------------------------------

type SyncError = NotFound | BadRequest | DbError | TaskSourceError | Schema.SchemaError

export interface TaskSyncShape {
  readonly sources: ReadonlyArray<SourceDescriptor>
  readonly list: Effect.Effect<ReadonlyArray<SourceConnection>, DbError>
  readonly get: (id: string) => Effect.Effect<SourceConnection, NotFound | DbError>
  readonly create: (body: CreateSourceConnectionBody) => Effect.Effect<SourceConnection, SyncError>
  readonly update: (id: string, body: UpdateSourceConnectionBody) => Effect.Effect<SourceConnection, SyncError>
  readonly remove: (id: string) => Effect.Effect<void, NotFound | DbError>
  readonly test: (id: string) => Effect.Effect<{ ok: boolean; message: string }, SyncError>
  /** Read-only import/refresh. Never creates, updates or transitions remote tasks. */
  readonly sync: (id: string, options?: { full?: boolean }) => Effect.Effect<SyncResult, SyncError>
}

export class TaskSync extends Context.Service<TaskSync, TaskSyncShape>()("agentdesk/TaskSync") {}

export interface TaskSyncOptions extends ConnectOptions {}

const FULL_SYNC_EVERY = Duration.toMillis(Duration.hours(12))
/** Sources may evaluate "updated since" in the user's timezone; overlap generously (upserts are idempotent). */
const WATERMARK_OVERLAP = Duration.toMillis(Duration.hours(26))

const initialStatus = (cat: RemoteTask["statusCategory"]): BoardStatus =>
  cat === "done" ? "done" : cat === "in_progress" ? "in_progress" : "todo"

export interface UpsertConnection {
  readonly id: string
  readonly provider: string
  readonly providerName: string
}

/**
 * Upsert one page of remote tasks inside a single transaction, keyed by the
 * stable remote id per (provider, connection). Connections are global: new
 * tickets are imported without a project and assigned on demand. Remote
 * status/assignee update the link only; the local board status, project and
 * other local fields are never overwritten.
 */
export const upsertTasks = (database: DatabaseShape, conn: UpsertConnection, tasks: ReadonlyArray<RemoteTask>, now: string) =>
  database.tx((db) => {
    let created = 0
    let updated = 0
    const changes: Array<{ ticketId: string; message: string; data: unknown }> = []
    for (const task of tasks) {
      const link = db
        .select()
        .from(ticketExternalLinks)
        .where(
          and(
            eq(ticketExternalLinks.provider, conn.provider),
            eq(ticketExternalLinks.connectionId, conn.id),
            eq(ticketExternalLinks.remoteId, task.remoteId)
          )
        )
        .get()
      const raw = { key: task.key, ...task.raw }
      if (!link) {
        const id = newId()
        db.insert(tickets)
          .values({
            id,
            projectId: null,
            number: 0,
            title: task.title,
            description: task.description,
            acceptanceCriteria: "",
            status: initialStatus(task.statusCategory),
            priority: "none",
            sourceKind: conn.provider,
            harness: null,
            model: null,
            workflowId: null,
            labels: [...task.labels],
            pinned: false,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now
          })
          .run()
        db.insert(ticketExternalLinks)
          .values({
            ticketId: id,
            provider: conn.provider,
            connectionId: conn.id,
            remoteId: task.remoteId,
            displayKey: task.key,
            url: task.url,
            remoteStatus: task.status,
            remoteAssignee: task.assignee,
            remoteUpdatedAt: task.updatedAt,
            remoteState: "active",
            lastSeenAt: now,
            raw
          })
          .run()
        created++
        changes.push({ ticketId: id, message: `Imported from ${conn.providerName} ${task.key}`, data: { remoteStatus: task.status } })
        continue
      }
      // Content is compared too, so a sync after a converter change (e.g. Jira ADF → Markdown)
      // rewrites stored descriptions even when the remote issue itself did not change.
      const local = db
        .select({ title: tickets.title, description: tickets.description })
        .from(tickets)
        .where(eq(tickets.id, link.ticketId))
        .get()
      const unchanged =
        link.remoteUpdatedAt === task.updatedAt &&
        link.remoteState === "active" &&
        link.displayKey === task.key &&
        local?.title === task.title &&
        local?.description === task.description
      db.update(ticketExternalLinks)
        .set({
          displayKey: task.key,
          url: task.url,
          remoteStatus: task.status,
          remoteAssignee: task.assignee,
          remoteUpdatedAt: task.updatedAt,
          remoteState: "active",
          lastSeenAt: now,
          raw
        })
        .where(eq(ticketExternalLinks.ticketId, link.ticketId))
        .run()
      if (unchanged) continue
      db.update(tickets)
        .set({ title: task.title, description: task.description, labels: [...task.labels], updatedAt: now })
        .where(eq(tickets.id, link.ticketId))
        .run()
      updated++
      if (link.remoteStatus !== task.status) {
        changes.push({
          ticketId: link.ticketId,
          message: `${conn.providerName} status changed: ${link.remoteStatus ?? "—"} → ${task.status ?? "—"}`,
          data: { from: link.remoteStatus, to: task.status }
        })
      } else if (link.remoteState === "missing") {
        changes.push({ ticketId: link.ticketId, message: `${task.key} is back in the sync scope`, data: null })
      }
    }
    return { created, updated, changes }
  })

export const TaskSyncLive = (options: TaskSyncOptions = {}) =>
  Layer.effect(
    TaskSync,
    Effect.gen(function* () {
      const database = yield* Database
      const { use } = database
      const registry = yield* TaskSources
      const credentials = yield* CredentialStore
      const activity = yield* Activity
      const notices = yield* Notices
      const config = yield* DaemonConfig
      const locks = new Map<string, Semaphore.Semaphore>()
      // One supervised polling fiber per connection; re-running a key replaces the old poller.
      const pollers = yield* FiberMap.make<string>()

      type Row = typeof sourceConnections.$inferSelect

      const getRow = (id: string) =>
        use((db) => db.select().from(sourceConnections).where(eq(sourceConnections.id, id)).get()).pipe(
          Effect.flatMap((r) => (r ? Effect.succeed(r) : Effect.fail(new NotFound({ entity: "source connection", id }))))
        )

      const get = (id: string) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          const s = yield* use((db) => db.select().from(sourceSyncState).where(eq(sourceSyncState.connectionId, id)).get())
          const secret = yield* credentials.get(row.credentialRef)
          return {
            id: row.id,
            provider: row.provider,
            name: row.name,
            settings: row.settings,
            pollIntervalSec: row.pollIntervalSec,
            enabled: row.enabled,
            hasCredential: !!secret,
            lastSyncAt: s?.lastSyncAt ?? null,
            lastFullSyncAt: s?.lastFullSyncAt ?? null,
            lastError: s?.lastError ?? null,
            createdAt: row.createdAt
          } satisfies SourceConnection
        })

      const list = Effect.gen(function* () {
        const rows = yield* use((db) => db.select().from(sourceConnections).all())
        return yield* Effect.forEach(rows, (r) => get(r.id).pipe(Effect.orDie))
      })

      /** Resolve the adapter, decode stored settings and connect with the stored credential. */
      const clientFor = (row: Row) =>
        Effect.gen(function* () {
          const adapter = yield* registry.get(row.provider)
          const settings = yield* registry.decodeSettings(row.provider, row.settings)
          const secret = yield* credentials.get(row.credentialRef)
          return { adapter, client: adapter.connect(settings, secret, options) as TaskSourceClient }
        })

      const lockFor = (id: string) => {
        let l = locks.get(id)
        if (!l) {
          l = Semaphore.makeUnsafe(1)
          locks.set(id, l)
        }
        return l
      }

      const recordFailure = (id: string, message: string) =>
        use((db) => {
          const s = db.select().from(sourceSyncState).where(eq(sourceSyncState.connectionId, id)).get()
          db.update(sourceSyncState)
            .set({ lastError: message, consecutiveFailures: (s?.consecutiveFailures ?? 0) + 1 })
            .where(eq(sourceSyncState.connectionId, id))
            .run()
        })

      const sync = (id: string, opts: { full?: boolean } = {}) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          const { adapter, client } = yield* clientFor(row)
          const state = yield* use((db) => db.select().from(sourceSyncState).where(eq(sourceSyncState.connectionId, id)).get())
          const nowMs = yield* Clock.currentTimeMillis
          const lastFull = state?.lastFullSyncAt ? Date.parse(state.lastFullSyncAt) : 0
          const full = opts.full || !state?.highWatermark || nowMs - lastFull > FULL_SYNC_EVERY
          const since = full ? undefined : new Date(Date.parse(state!.highWatermark!) - WATERMARK_OVERLAP)
          const startedAt = new Date(nowMs).toISOString()
          yield* Effect.annotateCurrentSpan({ provider: row.provider, full })
          const conn: UpsertConnection = { id: row.id, provider: row.provider, providerName: adapter.displayName }

          let fetched = 0
          let created = 0
          let updated = 0
          let watermark = state?.highWatermark ?? null
          const seen: Array<string> = []
          const changes: Array<{ ticketId: string; message: string; data: unknown }> = []
          let cursor: string | undefined
          do {
            const page = yield* client.fetchPage({ since, cursor })
            const r = yield* upsertTasks(database, conn, page.tasks, startedAt)
            fetched += page.tasks.length
            created += r.created
            updated += r.updated
            changes.push(...r.changes)
            for (const t of page.tasks) {
              seen.push(t.remoteId)
              if (t.updatedAt && (!watermark || Date.parse(t.updatedAt) > Date.parse(watermark))) watermark = t.updatedAt
            }
            cursor = page.cursor
          } while (cursor && fetched < 20_000)

          // Only a full sync can tell us a task left the scope (deleted, moved, permission lost).
          // Mark it missing; never delete local tickets or their run history.
          const missing = full
            ? yield* use(
                (db) =>
                  db
                    .update(ticketExternalLinks)
                    .set({ remoteState: "missing" })
                    .where(
                      and(
                        eq(ticketExternalLinks.connectionId, row.id),
                        eq(ticketExternalLinks.remoteState, "active"),
                        seen.length > 0 ? notInArray(ticketExternalLinks.remoteId, seen) : undefined
                      )
                    )
                    .run().changes
              )
            : 0
          yield* use((db) =>
            db
              .update(sourceSyncState)
              .set({
                lastSyncAt: startedAt,
                ...(full && { lastFullSyncAt: startedAt }),
                highWatermark: watermark,
                lastError: null,
                consecutiveFailures: 0
              })
              .where(eq(sourceSyncState.connectionId, row.id))
              .run()
          )
          for (const c of changes) {
            yield* activity.record({ kind: "source.updated", message: c.message, ticketId: c.ticketId, data: c.data })
          }
          if (created || updated || missing) {
            yield* activity.record({
              kind: "source.sync",
              message: `${adapter.displayName} sync (${row.name}): ${created} new, ${updated} updated, ${missing} missing`,
              data: { connectionId: row.id, provider: row.provider, full }
            })
          }
          yield* notices.publish({ topic: "sources" })
          yield* notices.publish({ topic: "tickets" })
          const result: SyncResult = { fetched, created, updated, missing, full }
          yield* Effect.annotateCurrentSpan({ ...result })
          return result
        }).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* recordFailure(id, e.message).pipe(Effect.ignore)
              yield* activity
                .record({ kind: "source.sync.failed", message: `Sync failed: ${e.message}`, data: { connectionId: id } })
                .pipe(Effect.ignore)
              yield* notices.publish({ topic: "sources" })
            })
          ),
          Semaphore.withPermit(lockFor(id)),
          Effect.withSpan("TaskSync.sync", { attributes: { connectionId: id } })
        )

      // ---- polling -----------------------------------------------------------------------
      interface PollOutcome {
        readonly enabled: boolean
        readonly failures: number
        readonly intervalMs: number
      }

      /** One polling tick: sync (errors are recorded, not fatal) and report how long to wait next. */
      const pollOnce = (id: string) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          if (!row.enabled) return { enabled: false, failures: 0, intervalMs: 0 } satisfies PollOutcome
          yield* sync(id).pipe(Effect.ignore)
          const state = yield* use((db) => db.select().from(sourceSyncState).where(eq(sourceSyncState.connectionId, id)).get())
          return {
            enabled: true,
            failures: state?.consecutiveFailures ?? 0,
            intervalMs: Math.max(60, row.pollIntervalSec) * 1000
          } satisfies PollOutcome
        })

      /** Poll on the connection's interval; after failures back off exponentially (capped at 30 minutes). */
      const pollSchedule = Schedule.forever.pipe(
        Schedule.setInputType<PollOutcome>(),
        Schedule.modifyDelay(({ input }) =>
          Effect.succeed(
            Duration.millis(input.failures > 0 ? Math.min(input.intervalMs * 2 ** input.failures, 30 * 60_000) : input.intervalMs)
          )
        )
      )

      const startPoller = (id: string) =>
        config.enableSourcePolling
          ? FiberMap.run(
              pollers,
              id,
              pollOnce(id).pipe(
                Effect.repeat({ schedule: pollSchedule, while: (o) => o.enabled }),
                Effect.catch((e) => Effect.logWarning("source poller stopped", e)),
                Effect.annotateLogs({ sourceConnectionId: id })
              )
            ).pipe(Effect.asVoid)
          : Effect.void

      const stopPoller = (id: string) => FiberMap.remove(pollers, id)

      // ---- CRUD ------------------------------------------------------------------------
      const create = Effect.fn("TaskSync.create")(function* (body: CreateSourceConnectionBody) {
        const adapter = yield* registry.get(body.provider)
        const settings = yield* registry.decodeSettings(body.provider, body.settings)
        const id = newId()
        const createdAt = yield* nowIso
        const credentialRef = `${body.provider}:${id}`
        yield* Effect.annotateCurrentSpan({ connectionId: id, provider: body.provider })
        if (body.token) yield* credentials.set(credentialRef, Redacted.make(body.token))
        yield* use((db) => {
          db.insert(sourceConnections)
            .values({
              id,
              provider: body.provider,
              name: body.name,
              settings,
              credentialRef,
              pollIntervalSec: Math.max(60, body.pollIntervalSec ?? 300),
              enabled: true,
              createdAt
            })
            .run()
          db.insert(sourceSyncState).values({ connectionId: id }).run()
        })
        yield* activity.record({
          kind: "source.connection",
          message: `${adapter.displayName} connection "${body.name}" added (read-only)`,
          actor: "user"
        })
        yield* startPoller(id)
        yield* notices.publish({ topic: "sources" })
        return yield* get(id)
      })

      const update = Effect.fn("TaskSync.update")(function* (id: string, body: UpdateSourceConnectionBody) {
        const row = yield* getRow(id)
        const settings = body.settings !== undefined ? yield* registry.decodeSettings(row.provider, body.settings) : undefined
        if (body.token) yield* credentials.set(row.credentialRef, Redacted.make(body.token))
        yield* use((db) =>
          db
            .update(sourceConnections)
            .set({
              ...(body.name !== undefined && { name: body.name }),
              ...(settings !== undefined && { settings }),
              ...(body.pollIntervalSec !== undefined && { pollIntervalSec: Math.max(60, body.pollIntervalSec) }),
              ...(body.enabled !== undefined && { enabled: body.enabled })
            })
            .where(eq(sourceConnections.id, id))
            .run()
        )
        if (settings !== undefined) {
          // Scope may have changed: force the next sync to be full so out-of-scope tasks are detected.
          yield* use((db) => db.update(sourceSyncState).set({ highWatermark: null }).where(eq(sourceSyncState.connectionId, id)).run())
        }
        const after = yield* getRow(id)
        if (after.enabled) yield* startPoller(id)
        else yield* stopPoller(id)
        yield* notices.publish({ topic: "sources" })
        return yield* get(id)
      })

      const remove = Effect.fn("TaskSync.remove")(function* (id: string) {
        const row = yield* getRow(id)
        yield* stopPoller(id)
        yield* credentials.remove(row.credentialRef)
        // Linked tickets stay (with their history), marked missing.
        yield* use((db) => {
          db.update(ticketExternalLinks).set({ remoteState: "missing" }).where(eq(ticketExternalLinks.connectionId, id)).run()
          db.delete(sourceSyncState).where(eq(sourceSyncState.connectionId, id)).run()
          db.delete(sourceConnections).where(eq(sourceConnections.id, id)).run()
        })
        yield* notices.publish({ topic: "sources" })
      })

      const test = Effect.fn("TaskSync.test")(function* (id: string) {
        const { client } = yield* clientFor(yield* getRow(id))
        return yield* client.test.pipe(
          Effect.map((message) => ({ ok: true, message })),
          Effect.catch((e) => Effect.succeed({ ok: false, message: e.message }))
        )
      })

      // Start pollers for enabled connections.
      const enabled = yield* use((db) => db.select().from(sourceConnections).where(eq(sourceConnections.enabled, true)).all()).pipe(
        Effect.orDie
      )
      for (const c of enabled) yield* startPoller(c.id)

      return TaskSync.of({ sources: registry.descriptors, list, get, create, update, remove, test, sync })
    })
  )
