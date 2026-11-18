import { AgentEvent, type AgentSession, type PlanItem, type StoredAgentEvent } from "@agentdesk/contracts"
import { agentEvents } from "@agentdesk/db"
import { redactDeep } from "@agentdesk/harness-core"
import { and, asc, desc, eq, gt, inArray, lt, max, sql } from "drizzle-orm"
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import type { DbError } from "../errors"
import { nowIso } from "../util"
import { Database } from "./database"

export interface EventLogShape {
  /** Redact, validate, persist (assigning a monotonic id) and then broadcast an event. */
  readonly append: (sessionId: string, event: AgentEvent) => Effect.Effect<StoredAgentEvent, DbError>
  /**
   * Events in id order. `after`/`before` bound the range; with `tail` the newest `limit`
   * events of that range are returned (still ascending), so a client can draw the end of a
   * long transcript first and page backwards with `before`.
   */
  readonly history: (
    sessionId: string,
    options?: { after?: number; before?: number; limit?: number; tail?: boolean }
  ) => Effect.Effect<ReadonlyArray<StoredAgentEvent>, DbError>
  readonly preview: (sessionId: string) => Effect.Effect<string | null, DbError>
  readonly lastEventId: (sessionId: string) => Effect.Effect<number, DbError>
  /** Progress through each session's latest plan (sessions that never planned are absent). */
  readonly plans: (sessionIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, SessionPlan>, DbError>
  /** Usage summed over each session's turns (sessions without finished turns are absent). */
  readonly usage: (sessionIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, SessionUsage>, DbError>
  /** Last event id per session in one query (sessions without events are absent). */
  readonly lastEventIds: (sessionIds: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, number>, DbError>
  /**
   * Replays persisted events after `after`, then streams live ones with no gap
   * and no duplicates: the live subscription is registered *before* history is
   * read, and live events at or below the last replayed id are dropped.
   */
  readonly subscribe: (sessionId: string, after?: number) => Stream.Stream<StoredAgentEvent, DbError>
}

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent)

export type SessionPlan = NonNullable<AgentSession["plan"]>
export type SessionUsage = NonNullable<AgentSession["usage"]>

/** "3 of 7 done, now: Run the tests" from a plan; null for an empty one. Cancelled steps don't count. */
export const planSummary = (items: ReadonlyArray<PlanItem>): SessionPlan | null => {
  const counted = items.filter((i) => i.status !== "cancelled")
  if (counted.length === 0) return null
  const current = counted.find((i) => i.status === "in_progress") ?? counted.find((i) => i.status === "pending")
  return { done: counted.filter((i) => i.status === "completed").length, total: counted.length, current: current?.text ?? null }
}

/** Add a finished turn to a session's usage. Input counts every token the model read, cached or not. */
export const addTurnUsage = (total: SessionUsage | null | undefined, event: AgentEvent): SessionUsage | null | undefined => {
  if (event.type !== "turn.completed" || (!event.usage && event.costUsd === undefined)) return total
  const u = event.usage
  const read = u ? u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : 0
  return {
    costUsd: event.costUsd === undefined ? (total?.costUsd ?? null) : (total?.costUsd ?? 0) + event.costUsd,
    inputTokens: (total?.inputTokens ?? 0) + read,
    outputTokens: (total?.outputTokens ?? 0) + (u?.outputTokens ?? 0)
  }
}

const PREVIEW_TYPES = ["message.completed", "user.prompt", "approval.requested", "session.error"] as const

/** The card preview an event sets (trimmed to 500 chars), or null for events that don't change it. */
export const previewText = (event: AgentEvent): string | null => {
  switch (event.type) {
    case "message.completed":
    case "user.prompt":
      return event.text.slice(0, 500)
    case "approval.requested":
      return event.summary.slice(0, 500)
    case "session.error":
      return event.message.slice(0, 500)
    default:
      return null
  }
}

export class EventLog extends Context.Service<EventLog, EventLogShape>()("agentdesk/EventLog") {
  static readonly layer = Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const { use } = yield* Database
      const pubsub = yield* PubSub.unbounded<StoredAgentEvent>()

      const toStored = (row: typeof agentEvents.$inferSelect): StoredAgentEvent => ({
        id: row.id,
        sessionId: row.sessionId,
        at: row.at,
        event: row.payload as AgentEvent
      })

      // Hot path (every streamed token): untraced on purpose.
      const append = Effect.fnUntraced(function* (sessionId: string, raw: AgentEvent) {
        const event = yield* decodeEvent(redactDeep(raw)).pipe(
          Effect.orElseSucceed(
            (): AgentEvent => ({ type: "session.error", message: `Dropped malformed ${String(raw?.type)} event` })
          )
        )
        const at = yield* nowIso
        const row = yield* use((db) =>
          db.insert(agentEvents).values({ sessionId, type: event.type, payload: event, at }).returning().get()
        )
        const stored = toStored(row)
        yield* PubSub.publish(pubsub, stored)
        return stored
      })

      const history: EventLogShape["history"] = (sessionId, options = {}) =>
        use((db) => {
          const rows = db
            .select()
            .from(agentEvents)
            .where(
              and(
                eq(agentEvents.sessionId, sessionId),
                gt(agentEvents.id, options.after ?? 0),
                options.before !== undefined ? lt(agentEvents.id, options.before) : undefined
              )
            )
            .orderBy(options.tail ? desc(agentEvents.id) : asc(agentEvents.id))
            .limit(options.limit ?? 100_000)
            .all()
          if (options.tail) rows.reverse()
          return rows.map(toStored)
        }).pipe(
          Effect.withSpan("EventLog.history", {
            attributes: { sessionId, after: options.after ?? 0, before: options.before ?? -1, tail: !!options.tail }
          })
        )

      // Fetch one meaningful event rather than downloading a transcript per dashboard card.
      const preview = (sessionId: string) => use((db) => {
        const row = db.select().from(agentEvents)
          .where(and(eq(agentEvents.sessionId, sessionId), inArray(agentEvents.type, [...PREVIEW_TYPES])))
          .orderBy(desc(agentEvents.id)).limit(1).get()
        return row ? previewText(row.payload as AgentEvent) : null
      })

      const lastEventId = (sessionId: string) =>
        use(
          (db) =>
            db
              .select({ id: agentEvents.id })
              .from(agentEvents)
              .where(eq(agentEvents.sessionId, sessionId))
              .orderBy(desc(agentEvents.id))
              .limit(1)
              .get()?.id ?? 0
        )

      const lastEventIds = (sessionIds: ReadonlyArray<string>) =>
        sessionIds.length === 0
          ? Effect.succeed(new Map<string, number>())
          : use(
              (db) =>
                new Map(
                  db
                    .select({ sessionId: agentEvents.sessionId, id: max(agentEvents.id) })
                    .from(agentEvents)
                    .where(inArray(agentEvents.sessionId, [...sessionIds]))
                    .groupBy(agentEvents.sessionId)
                    .all()
                    .map((r) => [r.sessionId, r.id ?? 0] as const)
                )
            )

      const subscribe = (sessionId: string, after = 0) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(pubsub)
            const replay = yield* history(sessionId, { after })
            const lastReplayed = replay.at(-1)?.id ?? after
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter((e) => e.sessionId === sessionId && e.id > lastReplayed)
            )
            return Stream.concat(Stream.fromIterable(replay), live)
          })
        )

      const plans = (sessionIds: ReadonlyArray<string>) =>
        sessionIds.length === 0
          ? Effect.succeed(new Map<string, SessionPlan>())
          : use((db) => {
              const latest = db
                .select({ id: max(agentEvents.id) })
                .from(agentEvents)
                .where(and(inArray(agentEvents.sessionId, [...sessionIds]), eq(agentEvents.type, "plan.updated")))
                .groupBy(agentEvents.sessionId)
                .all()
                .flatMap((r) => (r.id === null ? [] : [r.id]))
              if (latest.length === 0) return new Map<string, SessionPlan>()
              const rows = db.select().from(agentEvents).where(inArray(agentEvents.id, latest)).all()
              return new Map(
                rows.flatMap((r) => {
                  const e = r.payload as AgentEvent
                  const plan = e.type === "plan.updated" ? planSummary(e.items) : null
                  return plan ? [[r.sessionId, plan] as const] : []
                })
              )
            })

      const usage = (sessionIds: ReadonlyArray<string>) =>
        sessionIds.length === 0
          ? Effect.succeed(new Map<string, SessionUsage>())
          : use((db) => {
              const n = (path: string) => sql<number | null>`sum(json_extract(${agentEvents.payload}, ${path}))`
              const rows = db
                .select({
                  sessionId: agentEvents.sessionId,
                  cost: n("$.costUsd"),
                  costs: sql<number>`count(json_extract(${agentEvents.payload}, '$.costUsd'))`,
                  input: n("$.usage.inputTokens"),
                  cacheRead: n("$.usage.cacheReadTokens"),
                  cacheWrite: n("$.usage.cacheWriteTokens"),
                  output: n("$.usage.outputTokens")
                })
                .from(agentEvents)
                .where(and(inArray(agentEvents.sessionId, [...sessionIds]), eq(agentEvents.type, "turn.completed")))
                .groupBy(agentEvents.sessionId)
                .all()
              return new Map(
                rows.flatMap((r) => {
                  const read = (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0)
                  if (r.costs === 0 && read === 0 && !r.output) return []
                  return [[r.sessionId, { costUsd: r.costs > 0 ? (r.cost ?? 0) : null, inputTokens: read, outputTokens: r.output ?? 0 }] as const]
                })
              )
            })

      return EventLog.of({ append, history, preview, plans, usage, lastEventId, lastEventIds, subscribe })
    })
  )
}
