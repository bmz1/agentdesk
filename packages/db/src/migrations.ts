/**
 * Ordered, append-only SQL migrations. Embedded as strings so the daemon can be
 * bundled into a single file without shipping a migrations folder.
 * Never edit a released migration; add a new one.
 */
export interface Migration {
  readonly id: number
  readonly name: string
  readonly sql: string
}

export const migrations: ReadonlyArray<Migration> = [
  {
    id: 1,
    name: "initial",
    sql: /* sql */ `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  git_provider TEXT NOT NULL,
  default_harness TEXT NOT NULL,
  default_workflow_id TEXT,
  permission_mode TEXT NOT NULL,
  test_command TEXT,
  ticket_counter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  harness TEXT,
  workflow_id TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX tickets_project_idx ON tickets(project_id);
CREATE UNIQUE INDEX tickets_project_number ON tickets(project_id, number);

CREATE VIRTUAL TABLE tickets_fts USING fts5(title, description, content='tickets', content_rowid='rowid');
CREATE TRIGGER tickets_ai AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;
CREATE TRIGGER tickets_ad AFTER DELETE ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
END;
CREATE TRIGGER tickets_au AFTER UPDATE OF title, description ON tickets BEGIN
  INSERT INTO tickets_fts(tickets_fts, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description);
  INSERT INTO tickets_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
END;

CREATE TABLE ticket_external_links (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id),
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  display_key TEXT NOT NULL,
  url TEXT NOT NULL,
  remote_status TEXT,
  remote_assignee TEXT,
  remote_updated_at TEXT,
  remote_state TEXT NOT NULL DEFAULT 'active',
  last_seen_at TEXT NOT NULL,
  raw TEXT
);
CREATE UNIQUE INDEX ext_provider_remote ON ticket_external_links(provider, connection_id, remote_id);

CREATE TABLE jira_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deployment TEXT NOT NULL,
  base_url TEXT NOT NULL,
  principal TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  jql TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  poll_interval_sec INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE jira_sync_state (
  connection_id TEXT PRIMARY KEY REFERENCES jira_connections(id),
  last_sync_at TEXT,
  last_full_sync_at TEXT,
  high_watermark TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workflow_definitions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  yaml TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX workflow_id_version ON workflow_definitions(id, version);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT,
  ticket_id TEXT,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  cleanup_state TEXT NOT NULL,
  locked_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  active_step_id TEXT,
  workspace_id TEXT,
  harness_override TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX runs_ticket_idx ON workflow_runs(ticket_id);
CREATE INDEX runs_status_idx ON workflow_runs(status);

CREATE TABLE step_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  session_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX steps_run_idx ON step_runs(run_id);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  run_id TEXT,
  step_run_id TEXT,
  workspace_id TEXT,
  harness TEXT NOT NULL,
  provider_session_id TEXT,
  runner_instance TEXT,
  state TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sessions_ticket_idx ON agent_sessions(ticket_id);
CREATE INDEX sessions_state_idx ON agent_sessions(state);

CREATE TABLE agent_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX events_session_idx ON agent_events(session_id, id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  run_id TEXT,
  step_run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  provider_request_id TEXT,
  details TEXT,
  decision TEXT,
  actor TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX approvals_pending_idx ON approvals(decision);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_run_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  content TEXT,
  sha256 TEXT,
  git_commit TEXT,
  url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT,
  at TEXT NOT NULL
);
CREATE INDEX activity_ticket_idx ON activity_events(ticket_id, id);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`
  },
  {
    id: 2,
    name: "generic_task_sources",
    // Jira-specific connection tables become generic task-source tables.
    // Provider settings move to validated JSON; credential refs and ticket links are kept.
    sql: /* sql */ `
CREATE TABLE source_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  settings TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  poll_interval_sec INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX source_connections_provider_idx ON source_connections(provider);

CREATE TABLE source_sync_state (
  connection_id TEXT PRIMARY KEY REFERENCES source_connections(id),
  last_sync_at TEXT,
  last_full_sync_at TEXT,
  high_watermark TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

INSERT INTO source_connections (id, provider, name, project_id, settings, credential_ref, poll_interval_sec, enabled, created_at)
  SELECT id, 'jira', name, project_id,
         json_object('deployment', deployment, 'baseUrl', base_url, 'principal', principal, 'jql', jql),
         credential_ref, poll_interval_sec, enabled, created_at
  FROM jira_connections;

INSERT INTO source_sync_state (connection_id, last_sync_at, last_full_sync_at, high_watermark, last_error, consecutive_failures)
  SELECT connection_id, last_sync_at, last_full_sync_at, high_watermark, last_error, consecutive_failures
  FROM jira_sync_state;

DROP TABLE jira_sync_state;
DROP TABLE jira_connections;
`
  }
]
