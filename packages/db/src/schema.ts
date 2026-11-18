import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const ts = (name: string) => text(name)
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>()

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  defaultBranch: text("default_branch").notNull(),
  gitProvider: text("git_provider").notNull(),
  defaultHarness: text("default_harness").notNull(),
  defaultWorkflowId: text("default_workflow_id"),
  permissionMode: text("permission_mode").notNull(),
  inheritHarnessPermissions: integer("inherit_harness_permissions", { mode: "boolean" }).notNull().default(false),
  testCommand: text("test_command"),
  setupCommand: text("setup_command"),
  ticketCounter: integer("ticket_counter").notNull().default(0),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull()
})

export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    sourceKind: text("source_kind").notNull(),
    harness: text("harness"),
    model: text("model"),
    effort: text("effort"),
    permissionMode: text("permission_mode"),
    workflowId: text("workflow_id"),
    labels: json<Array<string>>("labels").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    tracked: integer("tracked", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    lastActivityAt: ts("last_activity_at").notNull()
  },
  (t) => [index("tickets_project_idx").on(t.projectId), uniqueIndex("tickets_project_number").on(t.projectId, t.number)]
)

export const ticketExternalLinks = sqliteTable(
  "ticket_external_links",
  {
    ticketId: text("ticket_id").primaryKey().references(() => tickets.id),
    provider: text("provider").notNull(),
    connectionId: text("connection_id").notNull(),
    remoteId: text("remote_id").notNull(),
    displayKey: text("display_key").notNull(),
    url: text("url").notNull(),
    remoteStatus: text("remote_status"),
    remoteAssignee: text("remote_assignee"),
    remoteUpdatedAt: text("remote_updated_at"),
    remoteState: text("remote_state").notNull().default("active"),
    lastSeenAt: ts("last_seen_at").notNull(),
    raw: json<unknown>("raw")
  },
  (t) => [uniqueIndex("ext_provider_remote").on(t.provider, t.connectionId, t.remoteId)]
)

/** One configured task source (Jira site + JQL, Linear team, …). Secrets live in the OS credential store. */
export const sourceConnections = sqliteTable("source_connections", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  name: text("name").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id),
  /** Provider settings, validated by the adapter's schema. Never contains secrets. */
  settings: json<unknown>("settings").notNull(),
  credentialRef: text("credential_ref").notNull(),
  pollIntervalSec: integer("poll_interval_sec").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: ts("created_at").notNull()
})

export const sourceSyncState = sqliteTable("source_sync_state", {
  connectionId: text("connection_id").primaryKey().references(() => sourceConnections.id),
  lastSyncAt: text("last_sync_at"),
  lastFullSyncAt: text("last_full_sync_at"),
  /** Highest remote `updated` timestamp observed; used for incremental fetches. */
  highWatermark: text("high_watermark"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0)
})

export const workflowDefinitions = sqliteTable(
  "workflow_definitions",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    yaml: text("yaml").notNull(),
    plan: json<unknown>("plan").notNull(),
    createdAt: ts("created_at").notNull()
  },
  (t) => [uniqueIndex("workflow_id_version").on(t.id, t.version)]
)

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  runId: text("run_id"),
  ticketId: text("ticket_id"),
  branch: text("branch").notNull(),
  path: text("path").notNull(),
  baseCommit: text("base_commit").notNull(),
  cleanupState: text("cleanup_state").notNull(),
  /** "pending" until the project's setup script succeeded here; worktrees from before setup scripts are "done". */
  setupState: text("setup_state").notNull().default("done"),
  /** Session or run currently holding the exclusive writer lock. */
  lockedBy: text("locked_by"),
  createdAt: ts("created_at").notNull()
})

export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull().references(() => tickets.id),
    workflowId: text("workflow_id").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    status: text("status").notNull(),
    activeStepId: text("active_step_id"),
    workspaceId: text("workspace_id"),
    harnessOverride: text("harness_override"),
    error: text("error"),
    createdAt: ts("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at")
  },
  (t) => [index("runs_ticket_idx").on(t.ticketId), index("runs_status_idx").on(t.status)]
)

export const stepRuns = sqliteTable(
  "step_runs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => workflowRuns.id),
    stepId: text("step_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    kind: text("kind").notNull(),
    attempt: integer("attempt").notNull(),
    state: text("state").notNull(),
    sessionId: text("session_id"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    input: json<unknown>("input"),
    output: text("output"),
    error: text("error"),
    startedAt: text("started_at"),
    finishedAt: text("finished_at")
  },
  (t) => [index("steps_run_idx").on(t.runId)]
)

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull().references(() => tickets.id),
    runId: text("run_id"),
    stepRunId: text("step_run_id"),
    workspaceId: text("workspace_id"),
    harness: text("harness").notNull(),
    providerSessionId: text("provider_session_id"),
    runnerInstance: text("runner_instance"),
    state: text("state").notNull(),
    cwd: text("cwd").notNull(),
    pid: integer("pid"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull()
  },
  (t) => [index("sessions_ticket_idx").on(t.ticketId), index("sessions_state_idx").on(t.state)]
)

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    type: text("type").notNull(),
    payload: json<unknown>("payload").notNull(),
    at: ts("at").notNull()
  },
  (t) => [index("events_session_idx").on(t.sessionId, t.id)]
)

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    ticketId: text("ticket_id").notNull(),
    runId: text("run_id"),
    stepRunId: text("step_run_id"),
    sessionId: text("session_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    providerRequestId: text("provider_request_id"),
    details: json<unknown>("details"),
    decision: text("decision"),
    actor: text("actor"),
    note: text("note"),
    createdAt: ts("created_at").notNull(),
    decidedAt: text("decided_at")
  },
  (t) => [index("approvals_pending_idx").on(t.decision)]
)

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  stepRunId: text("step_run_id"),
  type: text("type").notNull(),
  name: text("name").notNull(),
  path: text("path"),
  content: text("content"),
  sha256: text("sha256"),
  gitCommit: text("git_commit"),
  url: text("url"),
  createdAt: ts("created_at").notNull()
})

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ticketId: text("ticket_id"),
    runId: text("run_id"),
    kind: text("kind").notNull(),
    actor: text("actor").notNull(),
    message: text("message").notNull(),
    data: json<unknown>("data"),
    at: ts("at").notNull()
  },
  (t) => [index("activity_ticket_idx").on(t.ticketId, t.id)]
)

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull()
})
