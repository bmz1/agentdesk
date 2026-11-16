import { type Db, openDatabase } from "@agentdesk/db"
import type BetterSqlite3 from "better-sqlite3"
import { Context, Effect, Layer } from "effect"
import { DaemonConfig } from "../config"
import { DbError } from "../errors"

export interface DatabaseShape {
  readonly db: Db
  readonly sqlite: BetterSqlite3.Database
  /** Run a synchronous query, mapping exceptions to DbError. */
  readonly use: <A>(f: (db: Db) => A) => Effect.Effect<A, DbError>
  /** Run synchronous work inside a SQLite transaction (all-or-nothing). */
  readonly tx: <A>(f: (db: Db) => A) => Effect.Effect<A, DbError>
}

export class Database extends Context.Service<Database, DatabaseShape>()("agentdesk/Database") {}

const toDbError = (cause: unknown) =>
  new DbError({ message: cause instanceof Error ? cause.message : String(cause), cause })

export const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* DaemonConfig
    const opened = yield* Effect.acquireRelease(
      Effect.try({ try: () => openDatabase(config.dbPath), catch: toDbError }),
      (o) => Effect.sync(() => o.close())
    )
    const { db, sqlite } = opened
    return {
      db,
      sqlite,
      use: (f) => Effect.try({ try: () => f(db), catch: toDbError }),
      tx: (f) => Effect.try({ try: () => sqlite.transaction(() => f(db))(), catch: toDbError })
    } satisfies DatabaseShape
  }).pipe(Effect.orDie)
)
