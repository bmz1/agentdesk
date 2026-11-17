import { AgentEvent, type StoredAgentEvent } from "@agentdesk/contracts"
import { agentEvents } from "@agentdesk/db"
import { redactDeep } from "@agentdesk/harness-core"
import { and, asc, desc, eq, gt } from "drizzle-orm"
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
import type { DbError } from "../errors"
import { nowIso } from "../util"
import { Database } from "./database"

export interface EventLogShape {
  /** Validate, persist (assigning a monotonic id) and then broadcast an event. */
  readonly append: (sessionId: string, event: AgentEvent) => Effect.Effect<StoredAgentEvent, DbError>
  readonly history: (
    sessionId: string,
    options?: { after?: number; limit?: number }
  ) => Effect.Effect<ReadonlyArray<StoredAgentEvent>, DbError>
  readonly lastEventId: (sessionId: string) => Effect.Effect<number, DbError>
  /**
   * Replays persisted events after `after`, then streams live ones with no gap
   * and no duplicates: the live subscription is registered *before* history is
   * read, and live events at or below the last replayed id are dropped.
   */
  readonly subscribe: (sessionId: string, after?: number) => Stream.Stream<StoredAgentEvent, DbError>
}

export class EventLog extends Context.Service<EventLog, EventLogShape>()("agentdesk/EventLog") {}

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent)

export const EventLogLive = Layer.effect(
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

    const append = (sessionId: string, raw: AgentEvent) =>
      Effect.gen(function* () {
        const event = yield* decodeEvent(redactDeep(raw)).pipe(
          Effect.orElseSucceed(
            (): AgentEvent => ({ type: "session.error", message: `Dropped malformed ${String(raw?.type)} event` })
          )
        )
        const at = nowIso()
        const row = yield* use((db) =>
          db.insert(agentEvents).values({ sessionId, type: event.type, payload: event, at }).returning().get()
        )
        const stored = toStored(row)
        yield* PubSub.publish(pubsub, stored)
        return stored
      })

    const history: EventLogShape["history"] = (sessionId, options = {}) =>
      use((db) =>
        db
          .select()
          .from(agentEvents)
          .where(and(eq(agentEvents.sessionId, sessionId), gt(agentEvents.id, options.after ?? 0)))
          .orderBy(asc(agentEvents.id))
          .limit(options.limit ?? 100_000)
          .all()
          .map(toStored)
      )

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

    return { append, history, lastEventId, subscribe } satisfies EventLogShape
  })
)
