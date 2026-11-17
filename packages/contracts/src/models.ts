import { Schema } from "effect"
import {
  ApprovalDecision,
  BoardStatus,
  GitProvider,
  HarnessId,
  PermissionMode,
  Priority,
  RunStatus,
  SessionState,
  StepState,
  TicketSource,
  WorkspaceMode
} from "./ids"

const NullableString = Schema.NullOr(Schema.String)

export const Project = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  repoPath: Schema.String,
  defaultBranch: Schema.String,
  gitProvider: GitProvider,
  defaultHarness: HarnessId,
  defaultWorkflowId: NullableString,
  permissionMode: PermissionMode,
  inheritHarnessPermissions: Schema.Boolean,
  testCommand: NullableString,
  createdAt: Schema.String,
  updatedAt: Schema.String
})
export type Project = typeof Project.Type

export const ExternalLink = Schema.Struct({
  /** Task source id ("jira", "linear", …). */
  provider: Schema.String,
  remoteId: Schema.String,
  displayKey: Schema.String,
  url: Schema.String,
  remoteStatus: NullableString,
  remoteAssignee: NullableString,
  remoteUpdatedAt: NullableString,
  /** "active" | "missing" (out of scope / deleted / no permission) */
  remoteState: Schema.Literals(["active", "missing"])
})
export type ExternalLink = typeof ExternalLink.Type

export const RunSummary = Schema.Struct({
  id: Schema.String,
  status: RunStatus,
  activeStepId: NullableString,
  needsInput: Schema.Boolean
})
export type RunSummary = typeof RunSummary.Type

export const Ticket = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  number: Schema.Number,
  /** Human identifier: Jira key when linked, `<PROJECT>-<n>` otherwise. */
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.String,
  acceptanceCriteria: Schema.String,
  status: BoardStatus,
  priority: Priority,
  source: TicketSource,
  harness: Schema.NullOr(HarnessId),
  /** Model for the ticket's harness; null uses the harness' own default. */
  model: NullableString,
  /** Reasoning effort for the ticket's harness; null uses the model's default. */
  effort: NullableString,
  workflowId: NullableString,
  labels: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  /** False for threads: conversations kept off the board until promoted. */
  tracked: Schema.Boolean,
  workspaceMode: WorkspaceMode,
  sortOrder: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lastActivityAt: Schema.String,
  external: Schema.NullOr(ExternalLink),
  latestRun: Schema.NullOr(RunSummary),
  activeSessionId: NullableString
})
export type Ticket = typeof Ticket.Type

export const AgentSession = Schema.Struct({
  id: Schema.String,
  ticketId: Schema.String,
  runId: NullableString,
  stepRunId: NullableString,
  harness: HarnessId,
  providerSessionId: NullableString,
  state: SessionState,
  cwd: Schema.String,
  pid: Schema.NullOr(Schema.Number),
  lastEventId: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String
})
export type AgentSession = typeof AgentSession.Type

export const StepRun = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  stepId: Schema.String,
  stepIndex: Schema.Number,
  kind: Schema.String,
  attempt: Schema.Number,
  state: StepState,
  sessionId: NullableString,
  idempotencyKey: Schema.String,
  output: NullableString,
  error: NullableString,
  startedAt: NullableString,
  finishedAt: NullableString
})
export type StepRun = typeof StepRun.Type

export const Workspace = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  runId: NullableString,
  branch: Schema.String,
  path: Schema.String,
  baseCommit: Schema.String,
  cleanupState: Schema.Literals(["active", "retained", "removed"]),
  createdAt: Schema.String
})
export type Workspace = typeof Workspace.Type

export const Artifact = Schema.Struct({
  id: Schema.String,
  runId: Schema.String,
  stepRunId: NullableString,
  type: Schema.String,
  name: Schema.String,
  path: NullableString,
  content: NullableString,
  sha256: NullableString,
  gitCommit: NullableString,
  url: NullableString,
  createdAt: Schema.String
})
export type Artifact = typeof Artifact.Type

export const WorkflowRun = Schema.Struct({
  id: Schema.String,
  ticketId: Schema.String,
  workflowId: Schema.String,
  workflowVersion: Schema.Number,
  status: RunStatus,
  activeStepId: NullableString,
  workspaceId: NullableString,
  error: NullableString,
  createdAt: Schema.String,
  startedAt: NullableString,
  finishedAt: NullableString
})
export type WorkflowRun = typeof WorkflowRun.Type

export const WorkflowRunDetail = Schema.Struct({
  ...WorkflowRun.fields,
  steps: Schema.Array(StepRun),
  plan: Schema.Array(
    Schema.Struct({ id: Schema.String, kind: Schema.String, name: Schema.String })
  ),
  workspace: Schema.NullOr(Workspace),
  artifacts: Schema.Array(Artifact),
  approvals: Schema.Array(Schema.suspend(() => Approval))
})
export type WorkflowRunDetail = typeof WorkflowRunDetail.Type

export const Approval = Schema.Struct({
  id: Schema.String,
  ticketId: Schema.String,
  runId: NullableString,
  stepRunId: NullableString,
  sessionId: NullableString,
  kind: Schema.Literals(["tool", "workflow_step", "pull_request"]),
  title: Schema.String,
  details: Schema.Unknown,
  decision: Schema.NullOr(ApprovalDecision),
  actor: NullableString,
  createdAt: Schema.String,
  decidedAt: NullableString
})
export type Approval = typeof Approval.Type

export const ActivityEvent = Schema.Struct({
  id: Schema.Number,
  ticketId: NullableString,
  runId: NullableString,
  kind: Schema.String,
  actor: Schema.String,
  message: Schema.String,
  data: Schema.Unknown,
  at: Schema.String
})
export type ActivityEvent = typeof ActivityEvent.Type

export const WorkflowDefinitionSummary = Schema.Struct({
  id: Schema.String,
  version: Schema.Number,
  name: Schema.String,
  yaml: Schema.String,
  steps: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, name: Schema.String })),
  createdAt: Schema.String
})
export type WorkflowDefinitionSummary = typeof WorkflowDefinitionSummary.Type

export const HarnessModel = Schema.Struct({
  /** Value passed to the harness (alias, model id, or `provider/model` for OpenCode). */
  id: Schema.String,
  label: Schema.String,
  /** Upstream provider, for harnesses that route to several (OpenCode). */
  provider: Schema.optional(Schema.String),
  /** Reasoning effort levels this model accepts, when they differ per model (Codex). */
  efforts: Schema.optional(Schema.Array(Schema.String)),
  defaultEffort: Schema.optional(Schema.String)
})
export type HarnessModel = typeof HarnessModel.Type

export const HarnessDetection = Schema.Struct({
  id: HarnessId,
  installed: Schema.Boolean,
  authenticated: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.String),
  binary: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  /** Models the harness offers; empty or missing means free-form entry only. */
  models: Schema.optional(Schema.Array(HarnessModel)),
  /** Reasoning effort levels for every model of the harness (Claude). Missing: per model, or unsupported. */
  efforts: Schema.optional(Schema.Array(Schema.String))
})
export type HarnessDetection = typeof HarnessDetection.Type

/** A configured task source connection (provider-specific settings are validated by its adapter). */
export const SourceConnection = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.String,
  projectId: Schema.String,
  settings: Schema.Unknown,
  pollIntervalSec: Schema.Number,
  enabled: Schema.Boolean,
  hasCredential: Schema.Boolean,
  lastSyncAt: NullableString,
  lastFullSyncAt: NullableString,
  lastError: NullableString,
  createdAt: Schema.String
})
export type SourceConnection = typeof SourceConnection.Type

export const SourceField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["text", "url", "textarea", "select", "number"]),
  required: Schema.optional(Schema.Boolean),
  placeholder: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  default: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })))
})
export type SourceField = typeof SourceField.Type

/** Describes an available task source so any UI can render its connection form. */
export const SourceDescriptor = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  fields: Schema.Array(SourceField),
  credential: Schema.Struct({ label: Schema.String, hint: Schema.String, required: Schema.Boolean })
})
export type SourceDescriptor = typeof SourceDescriptor.Type

export interface SyncResult {
  readonly fetched: number
  readonly created: number
  readonly updated: number
  readonly missing: number
  readonly full: boolean
}

export const DaemonInfo = Schema.Struct({
  version: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.String,
  dataDir: Schema.String,
  persistent: Schema.Boolean,
  activeSessions: Schema.Number,
  activeRuns: Schema.Number
})
export type DaemonInfo = typeof DaemonInfo.Type

export const Diff = Schema.Struct({
  branch: NullableString,
  baseCommit: NullableString,
  headCommit: NullableString,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      status: Schema.String,
      additions: Schema.Number,
      deletions: Schema.Number
    })
  ),
  patch: Schema.String,
  commits: Schema.Array(Schema.Struct({ sha: Schema.String, subject: Schema.String }))
})
export type Diff = typeof Diff.Type

/** Files of a ticket's working tree (its worktree, or the project repo before an agent starts). */
export const FileTree = Schema.Struct({
  root: Schema.String,
  /** "worktree" once an agent has created the ticket's branch, else "repository". */
  origin: Schema.Literals(["worktree", "repository"]),
  /** Tracked and untracked, non-ignored files; `status` is the git porcelain code when changed. */
  files: Schema.Array(Schema.Struct({ path: Schema.String, status: Schema.optional(Schema.String) })),
  truncated: Schema.Boolean
})
export type FileTree = typeof FileTree.Type

export const FileContent = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  binary: Schema.Boolean,
  /** True when only the first part of a large file is returned. */
  truncated: Schema.Boolean,
  content: Schema.String
})
export type FileContent = typeof FileContent.Type

/** Daemon-owned launch defaults, applied to future sessions and workflow steps. */
export const HarnessDefaults = Schema.Struct({
  model: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  permissionMode: PermissionMode,
  instructions: Schema.String.check(Schema.isMaxLength(20_000))
})
export type HarnessDefaults = typeof HarnessDefaults.Type

export const HarnessSettings = Schema.Struct({
  defaultHarness: HarnessId,
  harnesses: Schema.Struct({
    claude: HarnessDefaults,
    codex: HarnessDefaults,
    opencode: HarnessDefaults,
    mock: HarnessDefaults
  })
})
export type HarnessSettings = typeof HarnessSettings.Type
