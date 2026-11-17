import { agentEvents, agentSessions } from "@agentdesk/db"
import { and, inArray, lt } from "drizzle-orm"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { DaemonConfig } from "../config"
import type { DbError } from "../errors"
import { Database } from "./database"

export interface MaintenanceShape {
  /** Prune transcripts of sessions that ended before the retention window. Returns deleted event count. */
  readonly pruneTranscripts: (now?: Date) => Effect.Effect<number, DbError>
}

export class Maintenance extends Context.Service<Maintenance, MaintenanceShape>()("agentdesk/Maintenance") {}

const ENDED = ["completed", "failed", "closed", "interrupted"]

export const MaintenanceLive = Layer.effect(
  Maintenance,
  Effect.gen(function* () {
    const config = yield* DaemonConfig
    const { use, sqlite } = yield* Database

    const pruneTranscripts = (now = new Date()) =>
      use((db) => {
        const cutoff = new Date(now.getTime() - config.retentionDays * 86_400_000).toISOString()
        const old = db
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(and(inArray(agentSessions.state, ENDED), lt(agentSessions.updatedAt, cutoff)))
          .all()
          .map((r) => r.id)
        if (old.length === 0) return 0
        return db.delete(agentEvents).where(inArray(agentEvents.sessionId, old)).run().changes
      })

    // Daily housekeeping: transcript retention (audit activity is kept) and WAL checkpoint.
    yield* Effect.gen(function* () {
      const pruned = yield* pruneTranscripts()
      if (pruned > 0) yield* Effect.logInfo(`retention: pruned ${pruned} agent events older than ${config.retentionDays} days`)
      yield* Effect.sync(() => sqlite.pragma("wal_checkpoint(TRUNCATE)"))
    }).pipe(
      Effect.catch((e) => Effect.logWarning("maintenance failed", e)),
      Effect.repeat(Schedule.spaced(Duration.hours(24))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped
    )

    return { pruneTranscripts } satisfies MaintenanceShape
  })
)
