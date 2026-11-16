import type { ActivityEvent } from "@agentdesk/contracts"
import { activityEvents, tickets } from "@agentdesk/db"
import { desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import type { DbError } from "../errors"
import { nowIso } from "../util"
import { Database } from "./database"
import { Notices } from "./notices"

export interface RecordInput {
  readonly kind: string
  readonly message: string
  readonly ticketId?: string | null
  readonly runId?: string | null
  readonly actor?: string
  readonly data?: unknown
}

export interface ActivityShape {
  /** Append an immutable audit/activity record and bump the ticket's last activity. */
  readonly record: (input: RecordInput) => Effect.Effect<void, DbError>
  readonly list: (options: { ticketId?: string; limit?: number }) => Effect.Effect<ReadonlyArray<ActivityEvent>, DbError>
}

export class Activity extends Context.Service<Activity, ActivityShape>()("agentdesk/Activity") {}

export const ActivityLive = Layer.effect(
  Activity,
  Effect.gen(function* () {
    const { use, tx } = yield* Database
    const notices = yield* Notices
    return {
      record: (input) =>
        Effect.gen(function* () {
          const at = nowIso()
          yield* tx((db) => {
            db.insert(activityEvents)
              .values({
                ticketId: input.ticketId ?? null,
                runId: input.runId ?? null,
                kind: input.kind,
                actor: input.actor ?? "system",
                message: input.message,
                data: input.data ?? null,
                at
              })
              .run()
            if (input.ticketId) {
              db.update(tickets).set({ lastActivityAt: at }).where(eq(tickets.id, input.ticketId)).run()
            }
          })
          yield* notices.publish({ topic: "activity", ticketId: input.ticketId ?? undefined })
        }),
      list: ({ ticketId, limit }) =>
        use((db) =>
          db
            .select()
            .from(activityEvents)
            .where(ticketId ? eq(activityEvents.ticketId, ticketId) : undefined)
            .orderBy(desc(activityEvents.id))
            .limit(limit ?? 200)
            .all()
            .map((r) => ({ ...r, data: r.data ?? null }))
        )
    } satisfies ActivityShape
  })
)
