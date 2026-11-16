import { describe, expect, it } from "vitest"
import { migrate, migrations, openDatabase } from "../src"

describe("migrations", () => {
  it("applies all migrations once and is idempotent", () => {
    const { sqlite, close } = openDatabase(":memory:")
    expect(migrate(sqlite, migrations)).toEqual([])
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name)
    expect(tables).toEqual(expect.arrayContaining(["projects", "tickets", "agent_events", "workflow_runs"]))
    close()
  })

  it("keeps the full-text index in sync with tickets", () => {
    const { sqlite, close } = openDatabase(":memory:")
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at)
         VALUES ('p','P','P','/tmp','main','none','mock','ask',?,?)`
      )
      .run(now, now)
    sqlite
      .prepare(
        `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,created_at,updated_at,last_activity_at)
         VALUES ('t','p',1,'Refactor payment gateway','todo','none','local',?,?,?)`
      )
      .run(now, now, now)
    const hit = sqlite.prepare("SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH 'payment'").all()
    expect(hit).toHaveLength(1)
    sqlite.prepare("UPDATE tickets SET title='Something else' WHERE id='t'").run()
    expect(sqlite.prepare("SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH 'payment'").all()).toHaveLength(0)
    close()
  })
})
