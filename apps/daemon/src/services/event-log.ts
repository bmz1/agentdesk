import { AgentEvent, type StoredAgentEvent } from "@agentdesk/contracts"
import { agentEvents } from "@agentdesk/db"
import { redactDeep } from "@agentdesk/harness-core"
import { and, asc, desc, eq, gt, inArray, lt, max } from "drizzle-orm"
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

      return EventLog.of({ append, history, preview, lastEventId, lastEventIds, subscribe })
    })
  )
}
