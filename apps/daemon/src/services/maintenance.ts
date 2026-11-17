import { agentEvents, agentSessions } from "@agentdesk/db"
import { and, inArray, lt } from "drizzle-orm"
import { Clock, Context, Duration, Effect, Layer, Schedule } from "effect"
import { DaemonConfig } from "../config"
import type { DbError } from "../errors"
import { Database } from "./database"

export interface MaintenanceShape {
  /** Prune transcripts of sessions that ended before the retention window. Returns deleted event count. */
  readonly pruneTranscripts: Effect.Effect<number, DbError>
}

const ENDED = ["completed", "failed", "closed", "interrupted"]

export class Maintenance extends Context.Service<Maintenance, MaintenanceShape>()("agentdesk/Maintenance") {
  static readonly layer = Layer.effect(
    Maintenance,
    Effect.gen(function* () {
      const config = yield* DaemonConfig
      const { use, sqlite } = yield* Database

      const pruneTranscripts = Effect.gen(function* () {
        const cutoff = new Date((yield* Clock.currentTimeMillis) - config.retentionDays * 86_400_000).toISOString()
        const pruned = yield* use((db) => {
          const old = db
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(and(inArray(agentSessions.state, ENDED), lt(agentSessions.updatedAt, cutoff)))
            .all()
            .map((r) => r.id)
          return old.length === 0 ? 0 : db.delete(agentEvents).where(inArray(agentEvents.sessionId, old)).run().changes
        })
        yield* Effect.annotateCurrentSpan({ cutoff, pruned })
        return pruned
      }).pipe(Effect.withSpan("Maintenance.pruneTranscripts"))

      // Daily housekeeping on the Effect Clock: transcript retention (audit activity is kept) and WAL checkpoint.
      yield* Effect.gen(function* () {
        const pruned = yield* pruneTranscripts
        if (pruned > 0) yield* Effect.logInfo(`retention: pruned ${pruned} agent events older than ${config.retentionDays} days`)
        yield* Effect.sync(() => sqlite.pragma("wal_checkpoint(TRUNCATE)"))
      }).pipe(
        Effect.withSpan("Maintenance.daily"),
        Effect.catch((e) => Effect.logWarning("maintenance failed", e)),
        Effect.repeat(Schedule.spaced(Duration.hours(24))),
        Effect.delay(Duration.minutes(1)),
        Effect.forkScoped
      )

      return Maintenance.of({ pruneTranscripts })
    })
  )
}
