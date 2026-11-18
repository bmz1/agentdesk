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
    migrate(
      sqlite,
      migrations.filter((m) => m.id === 1)
    )
    const now = "2026-01-01T00:00:00.000Z"
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask',?,?)`
      )
      .run(now, now)
    sqlite
      .prepare(
        `INSERT INTO jira_connections (id,name,deployment,base_url,principal,credential_ref,jql,project_id,poll_interval_sec,enabled,created_at) VALUES ('c1','SEON','cloud','https://seon.atlassian.net','me@seon.io','jira:c1','project = SEON','p',300,1,?)`
      )
      .run(now)
    sqlite.prepare(`INSERT INTO jira_sync_state (connection_id, high_watermark, consecutive_failures) VALUES ('c1','2026-01-02',2)`).run()

    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 2)
      )
    ).toEqual([2])
    const row = sqlite.prepare("SELECT * FROM source_connections").get() as any
    expect(row).toMatchObject({ id: "c1", provider: "jira", name: "SEON", credential_ref: "jira:c1", poll_interval_sec: 300 })
    expect(JSON.parse(row.settings)).toEqual({
      deployment: "cloud",
      baseUrl: "https://seon.atlassian.net",
      principal: "me@seon.io",
      jql: "project = SEON"
    })
    expect(sqlite.prepare("SELECT * FROM source_sync_state").get()).toMatchObject({
      connection_id: "c1",
      high_watermark: "2026-01-02",
      consecutive_failures: 2
    })
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'jira_%'").all()).toEqual([])
  })
})

describe("migration 4: harness permission inheritance", () => {
  it("preserves existing explicit permissions", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 4)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','plan','now','now')`
      )
      .run()
    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 4)
      )
    ).toEqual([4])
    expect(sqlite.prepare("SELECT permission_mode, inherit_harness_permissions FROM projects WHERE id='p'").get()).toEqual({
      permission_mode: "plan",
      inherit_harness_permissions: 0
    })
    sqlite.close()
  })
})

describe("migration 5: ticket threads", () => {
  it("keeps existing tickets on the board with worktree-first behaviour", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 5)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','now','now','now')`
      )
      .run()
    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 5)
      )
    ).toEqual([5])
    expect(sqlite.prepare("SELECT tracked, workspace_mode FROM tickets WHERE id='t'").get()).toEqual({
      tracked: 1,
      workspace_mode: "worktree"
    })
    sqlite.close()
  })
})

describe("migration 6: ticket effort", () => {
  it("adds an empty effort to existing tickets", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 6)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','now','now','now')`
      )
      .run()
    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 6)
      )
    ).toEqual([6])
    expect(sqlite.prepare("SELECT effort FROM tickets WHERE id='t'").get()).toEqual({ effort: null })
    sqlite.close()
  })
})

describe("migration 7: worktree setup", () => {
  it("drops read-only threads and treats existing worktrees as set up", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 7)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,workspace_mode,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','readonly','now','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO workspaces (id,project_id,ticket_id,branch,path,base_commit,cleanup_state,created_at) VALUES ('w','p','t','b','/tmp/w','abc','active','now')`
      )
      .run()
    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 7)
      )
    ).toEqual([7])
    expect(sqlite.prepare("SELECT setup_command FROM projects WHERE id='p'").get()).toEqual({ setup_command: null })
    expect(sqlite.prepare("SELECT setup_state FROM workspaces WHERE id='w'").get()).toEqual({ setup_state: "done" })
    const columns = sqlite
      .prepare("PRAGMA table_info(tickets)")
      .all()
      .map((c: { name: string }) => c.name)
    expect(columns).not.toContain("workspace_mode")
    expect(sqlite.prepare("SELECT id FROM tickets").all()).toEqual([{ id: "t" }])
    sqlite.close()
  })
})

describe("migration 8: ticket permission mode", () => {
  it("leaves existing tickets following their project", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 8)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,labels,created_at,updated_at,last_activity_at) VALUES ('t','p',1,'T','todo','none','local','[]','now','now','now')`
      )
      .run()
    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 8)
      )
    ).toEqual([8])
    expect(sqlite.prepare("SELECT permission_mode FROM tickets WHERE id='t'").get()).toEqual({ permission_mode: null })
    sqlite.close()
  })
})

describe("migration 9: restarts keep conversations", () => {
  it("returns conversations interrupted by a restart to idle, but not workflow steps or unresumable ones", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 9)
    )
    const cols = sqlite
      .prepare("PRAGMA table_info(agent_sessions)")
      .all()
      .map((c: { name: string }) => c.name)
    const insert = (id: string, runId: string | null, provider: string | null) => {
      const row: Record<string, unknown> = {
        id,
        ticket_id: "t",
        harness: "mock",
        state: "interrupted",
        cwd: "/tmp",
        run_id: runId,
        provider_session_id: provider,
        created_at: "now",
        updated_at: "now"
      }
      const keys = Object.keys(row).filter((k) => cols.includes(k))
      sqlite.pragma("foreign_keys = OFF")
      sqlite
        .prepare(`INSERT INTO agent_sessions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .run(...keys.map((k) => row[k]))
    }
    insert("chat", null, "p1")
    insert("step", "run", "p2")
    insert("unresumable", null, null)
    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 9)
      )
    ).toEqual([9])
    const states = Object.fromEntries(
      sqlite
        .prepare("SELECT id, state FROM agent_sessions")
        .all()
        .map((r: { id: string; state: string }) => [r.id, r.state])
    )
    expect(states).toEqual({ chat: "idle", step: "interrupted", unresumable: "interrupted" })
    sqlite.close()
  })
})

describe("migration 10: global task sources", () => {
  it("keeps each connection's project as its default, makes the project optional and keeps sync state", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 10)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO source_connections (id,provider,name,project_id,settings,credential_ref,poll_interval_sec,enabled,created_at) VALUES ('c1','jira','SEON','p','{"jql":"x"}','jira:c1',300,1,'now')`
      )
      .run()
    sqlite.prepare(`INSERT INTO source_sync_state (connection_id, high_watermark, consecutive_failures) VALUES ('c1','2026-01-02',1)`).run()

    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 10)
      )
    ).toEqual([10])
    expect(sqlite.prepare("SELECT id, project_id, project_routes, settings, credential_ref FROM source_connections").get()).toEqual({
      id: "c1",
      project_id: "p",
      project_routes: "{}",
      settings: '{"jql":"x"}',
      credential_ref: "jira:c1"
    })
    expect(sqlite.prepare("SELECT high_watermark, consecutive_failures, unrouted FROM source_sync_state").get()).toEqual({
      high_watermark: "2026-01-02",
      consecutive_failures: 1,
      unrouted: "{}"
    })
    // Connections no longer need a project, but references are still enforced.
    sqlite
      .prepare(
        `INSERT INTO source_connections (id,provider,name,project_id,settings,credential_ref,poll_interval_sec,created_at) VALUES ('c2','jira','All',NULL,'{}','jira:c2',300,'now')`
      )
      .run()
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO source_connections (id,provider,name,project_id,settings,credential_ref,poll_interval_sec,created_at) VALUES ('c3','jira','x','nope','{}','jira:c3',300,'now')`
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
    expect(() => sqlite.prepare(`INSERT INTO source_sync_state (connection_id) VALUES ('ghost')`).run()).toThrow(/FOREIGN KEY/)
    expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'source_connections_provider_idx'").get()).toBeDefined()
    sqlite.close()
  })
})

describe("migration 11: global external tickets", () => {
  it("makes ticket projects optional while keeping ids, rowids, search, links and foreign keys", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")
    migrate(
      sqlite,
      migrations.filter((m) => m.id < 11)
    )
    sqlite
      .prepare(
        `INSERT INTO projects (id,key,name,repo_path,default_branch,git_provider,default_harness,permission_mode,created_at,updated_at) VALUES ('p','P','P','/tmp','main','none','mock','ask','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO tickets (id,project_id,number,title,description,status,priority,source_kind,labels,tracked,effort,created_at,updated_at,last_activity_at) VALUES ('t1','p',1,'Payment gateway','retry logic','todo','high','jira','["x"]',1,'high','now','now','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO ticket_external_links (ticket_id,provider,connection_id,remote_id,display_key,url,last_seen_at) VALUES ('t1','jira','c1','10','SEON-1','https://x','now')`
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO source_connections (id,provider,name,project_id,project_routes,settings,credential_ref,poll_interval_sec,created_at) VALUES ('c1','jira','J','p','{"SEON":"p"}','{}','jira:c1',300,'now')`
      )
      .run()
    sqlite.prepare(`INSERT INTO source_sync_state (connection_id, high_watermark) VALUES ('c1','2026-01-02')`).run()
    const rowid = (sqlite.prepare("SELECT rowid FROM tickets WHERE id='t1'").get() as any).rowid

    expect(
      migrate(
        sqlite,
        migrations.filter((m) => m.id <= 11)
      )
    ).toEqual([11])
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1)
    expect(sqlite.prepare("SELECT rowid, id, project_id, number, labels, effort, tracked FROM tickets").get()).toEqual({
      rowid,
      id: "t1",
      project_id: "p",
      number: 1,
      labels: '["x"]',
      effort: "high",
      tracked: 1
    })
    expect(sqlite.prepare("SELECT ticket_id FROM ticket_external_links").get()).toEqual({ ticket_id: "t1" })
    expect(sqlite.prepare("SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH 'retry'").all()).toEqual([{ rowid }])
    expect(
      sqlite
        .prepare("PRAGMA table_info(source_connections)")
        .all()
        .map((c: any) => c.name)
    ).toEqual(["id", "provider", "name", "settings", "credential_ref", "poll_interval_sec", "enabled", "created_at"])
    expect(sqlite.prepare("SELECT high_watermark FROM source_sync_state").get()).toEqual({ high_watermark: "2026-01-02" })

    // Unassigned tickets: no project, number 0, any number of them; search follows new rows.
    const insert = sqlite.prepare(
      `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,created_at,updated_at,last_activity_at) VALUES (?,NULL,0,?,'todo','none','jira','now','now','now')`
    )
    insert.run("u1", "Unassigned one")
    insert.run("u2", "Unassigned two")
    expect(sqlite.prepare("SELECT count(*) AS n FROM tickets_fts WHERE tickets_fts MATCH 'unassigned'").get()).toEqual({ n: 2 })
    // References are still enforced after the rebuild.
    expect(() => sqlite.prepare("UPDATE tickets SET project_id = 'nope' WHERE id = 'u1'").run()).toThrow(/FOREIGN KEY/)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO ticket_external_links (ticket_id,provider,connection_id,remote_id,display_key,url,last_seen_at) VALUES ('ghost','jira','c1','11','X-1','u','now')`
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO tickets (id,project_id,number,title,status,priority,source_kind,created_at,updated_at,last_activity_at) VALUES ('dup','p',1,'d','todo','none','local','now','now','now')`
        )
        .run()
    ).toThrow(/UNIQUE/)
    sqlite.close()
  })

  it("refuses to commit a rebuild that leaves broken references", () => {
    const Database = require("better-sqlite3")
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")
    migrate(sqlite, migrations)
    const bad = {
      id: 999,
      name: "bad",
      foreignKeysOff: true,
      sql: "INSERT INTO ticket_external_links (ticket_id,provider,connection_id,remote_id,display_key,url,last_seen_at) VALUES ('ghost','jira','c','r','K-1','u','now');"
    }
    expect(() => migrate(sqlite, [...migrations, bad])).toThrow(/broke foreign keys/)
    expect(sqlite.prepare("SELECT count(*) AS n FROM ticket_external_links").get()).toEqual({ n: 0 })
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1)
    sqlite.close()
  })
})
