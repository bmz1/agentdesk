import { describe, expect, it } from "@effect/vitest"
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

describe("migration 2: generic task sources", () => {
  it("moves Jira connections and sync state into source tables, keeping refs and links", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")
    migrate(sqlite, migrations.filter((m) => m.id === 1))
    const now = "2026-01-01T00:00:00.000Z"
    sqlite.prepare(`INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask',?,?)`).run(now, now)
    sqlite
      .prepare(`INSERT INTO jira_connections (id,name,deployment,base_url,principal,credential_ref,jql,project_id,poll_interval_sec,enabled,created_at) VALUES ('c1','SEON','cloud','https://seon.atlassian.net','me@seon.io','jira:c1','project = SEON','p',300,1,?)`)
      .run(now)
    sqlite.prepare(`INSERT INTO jira_sync_state (connection_id, high_watermark, consecutive_failures) VALUES ('c1','2026-01-02',2)`).run()

    expect(migrate(sqlite, migrations.filter((m) => m.id <= 2))).toEqual([2])
    const row = sqlite.prepare("SELECT * FROM source_connections").get() as any
    expect(row).toMatchObject({ id: "c1", provider: "jira", name: "SEON", credential_ref: "jira:c1", poll_interval_sec: 300 })
    expect(JSON.parse(row.settings)).toEqual({ deployment: "cloud", baseUrl: "https://seon.atlassian.net", principal: "me@seon.io", jql: "project = SEON" })
    expect(sqlite.prepare("SELECT * FROM source_sync_state").get()).toMatchObject({ connection_id: "c1", high_watermark: "2026-01-02", consecutive_failures: 2 })
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'jira_%'").all()).toEqual([])
  })
})

describe("migration 4: harness permission inheritance", () => {
  it("preserves existing explicit permissions", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(sqlite, migrations.filter((m) => m.id < 4))
    sqlite.prepare(`INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','plan','now','now')`).run()
    expect(migrate(sqlite, migrations.filter((m) => m.id <= 4))).toEqual([4])
    expect(sqlite.prepare("SELECT permission_mode, inherit_harness_permissions FROM projects WHERE id='p'").get()).toEqual({ permission_mode: "plan", inherit_harness_permissions: 0 })
    sqlite.close()
  })
})

describe("migration 5: ticket threads", () => {
  it("keeps existing tickets on the board with worktree-first behaviour", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(sqlite, migrations.filter((m) => m.id < 5))
    sqlite.prepare(`INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`).run()
    sqlite.prepare(`INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','now','now','now')`).run()
    expect(migrate(sqlite, migrations.filter((m) => m.id <= 5))).toEqual([5])
    expect(sqlite.prepare("SELECT tracked, workspace_mode FROM tickets WHERE id='t'").get()).toEqual({ tracked: 1, workspace_mode: "worktree" })
    sqlite.close()
  })
})

describe("migration 6: ticket effort", () => {
  it("adds an empty effort to existing tickets", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(sqlite, migrations.filter((m) => m.id < 6))
    sqlite.prepare(`INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`).run()
    sqlite.prepare(`INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','now','now','now')`).run()
    expect(migrate(sqlite, migrations.filter((m) => m.id <= 6))).toEqual([6])
    expect(sqlite.prepare("SELECT effort FROM tickets WHERE id='t'").get()).toEqual({ effort: null })
    sqlite.close()
  })
})

describe("migration 7: worktree setup", () => {
  it("drops read-only threads and treats existing worktrees as set up", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(sqlite, migrations.filter((m) => m.id < 7))
    sqlite.prepare(`INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`).run()
    sqlite.prepare(`INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,workspace_mode,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','readonly','now','now','now')`).run()
    sqlite.prepare(`INSERT INTO workspaces (id,project_id,ticket_id,branch,path,base_commit,cleanup_state,created_at) VALUES ('w','p','t','b','/tmp/w','abc','active','now')`).run()
    expect(migrate(sqlite, migrations)).toEqual([7])
    expect(sqlite.prepare("SELECT setup_command FROM projects WHERE id='p'").get()).toEqual({ setup_command: null })
    expect(sqlite.prepare("SELECT setup_state FROM workspaces WHERE id='w'").get()).toEqual({ setup_state: "done" })
    const columns = sqlite.prepare("PRAGMA table_info(tickets)").all().map((c: { name: string }) => c.name)
    expect(columns).not.toContain("workspace_mode")
    expect(sqlite.prepare("SELECT id FROM tickets").all()).toEqual([{ id: "t" }])
    sqlite.close()
  })
})
