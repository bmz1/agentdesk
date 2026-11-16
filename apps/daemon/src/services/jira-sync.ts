import type {
  BoardStatus,
  CreateJiraConnectionBody,
  JiraConnection,
  UpdateJiraConnectionBody
} from "@agentdesk/contracts"
import { jiraConnections, jiraSyncState, projects, ticketExternalLinks, tickets } from "@agentdesk/db"
import { incrementalJql, type JiraError, type JiraIssue, makeJiraClient } from "@agentdesk/jira"
import { and, eq, notInArray } from "drizzle-orm"
import { Context, Duration, Effect, Fiber, Layer, Semaphore } from "effect"
import { DaemonConfig } from "../config"
import { BadRequest, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { CredentialStore } from "./credentials"
import { Database, type DatabaseShape } from "./database"
import { Notices } from "./notices"
import { nextTicketNumber } from "./tickets"

export interface SyncResult {
  readonly fetched: number
  readonly created: number
  readonly updated: number
  readonly missing: number
  readonly full: boolean
}

type JiraSyncError = NotFound | BadRequest | DbError | JiraError

export interface JiraSyncShape {
  readonly list: Effect.Effect<ReadonlyArray<JiraConnection>, DbError>
  readonly create: (body: CreateJiraConnectionBody) => Effect.Effect<JiraConnection, JiraSyncError>
  readonly update: (id: string, body: UpdateJiraConnectionBody) => Effect.Effect<JiraConnection, JiraSyncError>
  readonly remove: (id: string) => Effect.Effect<void, JiraSyncError>
  readonly test: (id: string) => Effect.Effect<{ ok: boolean; message: string }, JiraSyncError>
  /** Read-only import/refresh. Never creates, updates or transitions remote issues. */
  readonly sync: (id: string, options?: { full?: boolean }) => Effect.Effect<SyncResult, JiraSyncError>
}

export class JiraSync extends Context.Service<JiraSync, JiraSyncShape>()("agentdesk/JiraSync") {}

export interface JiraSyncOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly retryBaseMs?: number
}

const FULL_SYNC_EVERY = Duration.toMillis(Duration.hours(12))
/** Jira interprets JQL dates in the user's profile timezone; overlap generously (upserts are idempotent). */
const WATERMARK_OVERLAP = Duration.toMillis(Duration.hours(26))

const initialStatus = (cat: JiraIssue["statusCategory"]): BoardStatus =>
  cat === "done" ? "done" : cat === "indeterminate" ? "in_progress" : "todo"

/**
 * Upsert one page of issues inside a single transaction, keyed by the stable
 * Jira issue id. Remote status/assignee update the link only; the local board
 * status is never overwritten after creation.
 */
export const upsertIssues = (
  database: DatabaseShape,
  conn: { id: string; projectId: string },
  issues: ReadonlyArray<JiraIssue>
) =>
  database.tx((db) => {
    const now = nowIso()
    let created = 0
    let updated = 0
    const changes: Array<{ ticketId: string; message: string; data: unknown }> = []
    for (const issue of issues) {
      const link = db
        .select()
        .from(ticketExternalLinks)
        .where(
          and(
            eq(ticketExternalLinks.provider, "jira"),
            eq(ticketExternalLinks.connectionId, conn.id),
            eq(ticketExternalLinks.remoteId, issue.id)
          )
        )
        .get()
      const raw = { key: issue.key, priority: issue.priority, issueType: issue.issueType }
      if (!link) {
        const id = newId()
        const number = nextTicketNumber(database, conn.projectId)
        db.insert(tickets)
          .values({
            id,
            projectId: conn.projectId,
            number,
            title: issue.title,
            description: issue.description,
            acceptanceCriteria: "",
            status: initialStatus(issue.statusCategory),
            priority: "none",
            sourceKind: "jira",
            harness: null,
            workflowId: null,
            labels: [...issue.labels],
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
            provider: "jira",
            connectionId: conn.id,
            remoteId: issue.id,
            displayKey: issue.key,
            url: issue.url,
            remoteStatus: issue.status,
            remoteAssignee: issue.assignee,
            remoteUpdatedAt: issue.updated,
            remoteState: "active",
            lastSeenAt: now,
            raw
          })
          .run()
        created++
        changes.push({ ticketId: id, message: `Imported from Jira ${issue.key}`, data: { remoteStatus: issue.status } })
        continue
      }
      const unchanged =
        link.remoteUpdatedAt === issue.updated && link.remoteState === "active" && link.displayKey === issue.key
      db.update(ticketExternalLinks)
        .set({
          displayKey: issue.key,
          url: issue.url,
          remoteStatus: issue.status,
          remoteAssignee: issue.assignee,
          remoteUpdatedAt: issue.updated,
          remoteState: "active",
          lastSeenAt: now,
          raw
        })
        .where(eq(ticketExternalLinks.ticketId, link.ticketId))
        .run()
      if (unchanged) continue
      db.update(tickets)
        .set({ title: issue.title, description: issue.description, labels: [...issue.labels], updatedAt: now })
        .where(eq(tickets.id, link.ticketId))
        .run()
      updated++
      if (link.remoteStatus !== issue.status) {
        changes.push({
          ticketId: link.ticketId,
          message: `Jira status changed: ${link.remoteStatus ?? "—"} → ${issue.status ?? "—"}`,
          data: { from: link.remoteStatus, to: issue.status }
        })
      } else if (link.remoteState === "missing") {
        changes.push({ ticketId: link.ticketId, message: `${issue.key} is back in the sync scope`, data: null })
      }
    }
    return { created, updated, changes }
  })

export const JiraSyncLive = (options: JiraSyncOptions = {}) =>
  Layer.effect(
    JiraSync,
    Effect.gen(function* () {
      const database = yield* Database
      const { use } = database
      const credentials = yield* CredentialStore
      const activity = yield* Activity
      const notices = yield* Notices
      const config = yield* DaemonConfig
      const locks = new Map<string, Semaphore.Semaphore>()
      const pollers = new Map<string, Fiber.Fiber<unknown, unknown>>()
      const layerScope = yield* Effect.scope

      const toConnection = (
        c: typeof jiraConnections.$inferSelect,
        s: typeof jiraSyncState.$inferSelect | undefined,
        hasCredential: boolean
      ): JiraConnection => ({
        id: c.id,
        name: c.name,
        deployment: c.deployment as JiraConnection["deployment"],
        baseUrl: c.baseUrl,
        principal: c.principal,
        jql: c.jql,
        projectId: c.projectId,
        pollIntervalSec: c.pollIntervalSec,
        enabled: c.enabled,
        hasCredential,
        lastSyncAt: s?.lastSyncAt ?? null,
        lastFullSyncAt: s?.lastFullSyncAt ?? null,
        lastError: s?.lastError ?? null,
        createdAt: c.createdAt
      })

      const getRow = (id: string) =>
        use((db) => db.select().from(jiraConnections).where(eq(jiraConnections.id, id)).get()).pipe(
          Effect.flatMap((r) => (r ? Effect.succeed(r) : Effect.fail(new NotFound({ entity: "jira connection", id }))))
        )

      const get = (id: string) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          const state = yield* use((db) => db.select().from(jiraSyncState).where(eq(jiraSyncState.connectionId, id)).get())
          const secret = yield* credentials.get(row.credentialRef)
          return toConnection(row, state, !!secret)
        })

      const list = Effect.gen(function* () {
        const rows = yield* use((db) => db.select().from(jiraConnections).all())
        return yield* Effect.forEach(rows, (r) => get(r.id).pipe(Effect.orDie))
      })

      const normalizeBaseUrl = (u: string) =>
        Effect.gen(function* () {
          let url: URL
          try {
            url = new URL(u.trim())
          } catch {
            return yield* new BadRequest({ message: `Invalid Jira URL: ${u}` })
          }
          if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) {
            return yield* new BadRequest({ message: "Jira URL must use https" })
          }
          return url.origin + url.pathname.replace(/\/+$/, "")
        })

      const clientFor = (row: typeof jiraConnections.$inferSelect) =>
        Effect.gen(function* () {
          const token = yield* credentials.get(row.credentialRef)
          if (!token) return yield* new BadRequest({ message: "No API token stored for this Jira connection" })
          return makeJiraClient({
            deployment: row.deployment as "cloud" | "datacenter",
            baseUrl: row.baseUrl,
            principal: row.principal,
            token,
            fetch: options.fetch,
            retryBaseMs: options.retryBaseMs
          })
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
          const s = db.select().from(jiraSyncState).where(eq(jiraSyncState.connectionId, id)).get()
          db.update(jiraSyncState)
            .set({ lastError: message, consecutiveFailures: (s?.consecutiveFailures ?? 0) + 1 })
            .where(eq(jiraSyncState.connectionId, id))
            .run()
        })

      const syncNow = (id: string, opts: { full?: boolean } = {}) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          const state = yield* use((db) => db.select().from(jiraSyncState).where(eq(jiraSyncState.connectionId, id)).get())
          const client = yield* clientFor(row)
          const lastFull = state?.lastFullSyncAt ? Date.parse(state.lastFullSyncAt) : 0
          const full = opts.full || !state?.highWatermark || Date.now() - lastFull > FULL_SYNC_EVERY
          const jql = full ? row.jql : incrementalJql(row.jql, new Date(Date.parse(state!.highWatermark!) - WATERMARK_OVERLAP))
          const startedAt = nowIso()
          let fetched = 0
          let created = 0
          let updated = 0
          let watermark = state?.highWatermark ?? null
          const seen: Array<string> = []
          const changes: Array<{ ticketId: string; message: string; data: unknown }> = []
          let cursor: string | undefined
          do {
            const page = yield* client.searchPage(jql, cursor)
            const r = yield* upsertIssues(database, { id: row.id, projectId: row.projectId }, page.issues)
            fetched += page.issues.length
            created += r.created
            updated += r.updated
            changes.push(...r.changes)
            for (const i of page.issues) {
              seen.push(i.id)
              if (i.updated && (!watermark || Date.parse(i.updated) > Date.parse(watermark))) watermark = i.updated
            }
            cursor = page.cursor
          } while (cursor && fetched < 20_000)

          // Only a full sync can tell us an issue left the scope (deleted, moved, permission lost).
          // Mark it missing; never delete local tickets or their run history.
          let missing = 0
          if (full) {
            missing = yield* use(
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
          }
          yield* use((db) =>
            db
              .update(jiraSyncState)
              .set({
                lastSyncAt: startedAt,
                ...(full && { lastFullSyncAt: startedAt }),
                highWatermark: watermark,
                lastError: null,
                consecutiveFailures: 0
              })
              .where(eq(jiraSyncState.connectionId, row.id))
              .run()
          )
          for (const c of changes) {
            yield* activity.record({ kind: "jira.updated", message: c.message, ticketId: c.ticketId, data: c.data })
          }
          if (created || updated || missing) {
            yield* activity.record({
              kind: "jira.sync",
              message: `Jira sync (${row.name}): ${created} new, ${updated} updated, ${missing} missing`,
              data: { connectionId: row.id, full }
            })
          }
          yield* notices.publish({ topic: "jira" })
          yield* notices.publish({ topic: "tickets" })
          return { fetched, created, updated, missing, full }
        }).pipe(
          Effect.tapError((e) =>
            Effect.gen(function* () {
              yield* recordFailure(id, e.message).pipe(Effect.ignore)
              yield* activity.record({ kind: "jira.sync.failed", message: `Jira sync failed: ${e.message}` }).pipe(Effect.ignore)
              yield* notices.publish({ topic: "jira" })
            })
          ),
          Semaphore.withPermit(lockFor(id)),
          Effect.withSpan("jira.sync", { attributes: { connectionId: id } })
        )

      /** Bounded polling with exponential backoff on consecutive failures (capped at 30 minutes). */
      const startPoller = (id: string) =>
        Effect.gen(function* () {
          const existing = pollers.get(id)
          if (existing) yield* Fiber.interrupt(existing)
          if (!config.enableJiraPolling) return
          const loop = Effect.gen(function* () {
            while (true) {
              const row = yield* getRow(id)
              if (!row.enabled) return
              yield* syncNow(id).pipe(Effect.ignore)
              const s = yield* use((db) => db.select().from(jiraSyncState).where(eq(jiraSyncState.connectionId, id)).get())
              const failures = s?.consecutiveFailures ?? 0
              const base = Math.max(60, row.pollIntervalSec) * 1000
              const delay = failures > 0 ? Math.min(base * 2 ** failures, 30 * 60_000) : base
              yield* Effect.sleep(Duration.millis(delay))
            }
          }).pipe(Effect.catch(() => Effect.void))
          const fiber = yield* Effect.forkIn(loop, layerScope)
          pollers.set(id, fiber)
        })

      const stopPoller = (id: string) =>
        Effect.gen(function* () {
          const f = pollers.get(id)
          if (f) yield* Fiber.interrupt(f)
          pollers.delete(id)
        })

      const create = (body: CreateJiraConnectionBody) =>
        Effect.gen(function* () {
          const baseUrl = yield* normalizeBaseUrl(body.baseUrl)
          const project = yield* use((db) => db.select().from(projects).where(eq(projects.id, body.projectId)).get())
          if (!project) return yield* new NotFound({ entity: "project", id: body.projectId })
          if (body.deployment === "cloud" && !body.principal) {
            return yield* new BadRequest({ message: "Jira Cloud needs the account email as principal" })
          }
          const id = newId()
          const credentialRef = `jira:${id}`
          if (body.token) yield* credentials.set(credentialRef, body.token)
          yield* use((db) => {
            db.insert(jiraConnections)
              .values({
                id,
                name: body.name,
                deployment: body.deployment,
                baseUrl,
                principal: body.principal,
                credentialRef,
                jql: body.jql,
                projectId: body.projectId,
                pollIntervalSec: Math.max(60, body.pollIntervalSec ?? 300),
                enabled: true,
                createdAt: nowIso()
              })
              .run()
            db.insert(jiraSyncState).values({ connectionId: id }).run()
          })
          yield* activity.record({ kind: "jira.connection", message: `Jira connection "${body.name}" added (read-only)`, actor: "user" })
          yield* startPoller(id)
          yield* notices.publish({ topic: "jira" })
          return yield* get(id)
        })

      const update = (id: string, body: UpdateJiraConnectionBody) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          if (body.token) yield* credentials.set(row.credentialRef, body.token)
          yield* use((db) =>
            db
              .update(jiraConnections)
              .set({
                ...(body.name !== undefined && { name: body.name }),
                ...(body.jql !== undefined && { jql: body.jql }),
                ...(body.principal !== undefined && { principal: body.principal }),
                ...(body.pollIntervalSec !== undefined && { pollIntervalSec: Math.max(60, body.pollIntervalSec) }),
                ...(body.enabled !== undefined && { enabled: body.enabled })
              })
              .where(eq(jiraConnections.id, id))
              .run()
          )
          if (body.jql !== undefined) {
            // Scope changed: force the next sync to be full so out-of-scope issues are detected.
            yield* use((db) => db.update(jiraSyncState).set({ highWatermark: null }).where(eq(jiraSyncState.connectionId, id)).run())
          }
          const after = yield* getRow(id)
          if (after.enabled) yield* startPoller(id)
          else yield* stopPoller(id)
          yield* notices.publish({ topic: "jira" })
          return yield* get(id)
        })

      const remove = (id: string) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          yield* stopPoller(id)
          yield* credentials.remove(row.credentialRef)
          // Linked tickets stay (with their history) as local tickets marked missing.
          yield* use((db) => {
            db.update(ticketExternalLinks).set({ remoteState: "missing" }).where(eq(ticketExternalLinks.connectionId, id)).run()
            db.delete(jiraSyncState).where(eq(jiraSyncState.connectionId, id)).run()
            db.delete(jiraConnections).where(eq(jiraConnections.id, id)).run()
          })
          yield* notices.publish({ topic: "jira" })
        })

      const test = (id: string) =>
        Effect.gen(function* () {
          const row = yield* getRow(id)
          const client = yield* clientFor(row)
          return yield* client.myself.pipe(
            Effect.map((me) => ({ ok: true, message: `Authenticated as ${me.displayName}` })),
            Effect.catch((e: JiraError) => Effect.succeed({ ok: false, message: e.message }))
          )
        })

      // Start pollers for enabled connections.
      const enabled = yield* use((db) => db.select().from(jiraConnections).where(eq(jiraConnections.enabled, true)).all()).pipe(Effect.orDie)
      for (const c of enabled) yield* startPoller(c.id)

      return { list, create, update, remove, test, sync: syncNow } satisfies JiraSyncShape
    })
  )
