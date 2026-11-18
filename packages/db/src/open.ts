import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrations, type Migration } from "./migrations"
import * as schema from "./schema"

export type Db = BetterSQLite3Database<typeof schema>
export interface OpenedDatabase {
  readonly sqlite: Database.Database
  readonly db: Db
  readonly close: () => void
}

/** Opens (or creates) the SQLite database, enables WAL and applies pending migrations. */
export const openDatabase = (filename: string, extra: ReadonlyArray<Migration> = []): OpenedDatabase => {
  const sqlite = new Database(filename)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("synchronous = NORMAL")
  sqlite.pragma("foreign_keys = ON")
  sqlite.pragma("busy_timeout = 5000")
  migrate(sqlite, [...migrations, ...extra])
  const db = drizzle(sqlite, { schema })
  return { sqlite, db, close: () => sqlite.close() }
}

export const migrate = (sqlite: Database.Database, all: ReadonlyArray<Migration>) => {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
  )
  const applied = new Set(
    (sqlite.prepare("SELECT id FROM _migrations").all() as Array<{ id: number }>).map((r) => r.id)
  )
  const pending = [...all].sort((a, b) => a.id - b.id).filter((m) => !applied.has(m.id))
  for (const m of pending) {
    // foreign_keys cannot change inside a transaction, so it is switched around it.
    const restoreForeignKeys = m.foreignKeysOff && sqlite.pragma("foreign_keys", { simple: true }) === 1
    if (m.foreignKeysOff) sqlite.pragma("foreign_keys = OFF")
    try {
      sqlite.transaction(() => {
        sqlite.exec(m.sql)
        if (m.foreignKeysOff) {
          const broken = sqlite.prepare("PRAGMA foreign_key_check").all()
          if (broken.length > 0) throw new Error(`Migration ${m.id} (${m.name}) broke foreign keys: ${JSON.stringify(broken.slice(0, 5))}`)
        }
        sqlite
          .prepare("INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)")
          .run(m.id, m.name, new Date().toISOString())
      })()
    } finally {
      if (restoreForeignKeys) sqlite.pragma("foreign_keys = ON")
    }
  }
  return pending.map((m) => m.id)
}
