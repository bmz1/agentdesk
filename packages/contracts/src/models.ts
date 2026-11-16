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
  TicketSource
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
  testCommand: NullableString,
  createdAt: Schema.String,
  updatedAt: Schema.String
})
export type Project = typeof Project.Type

export const ExternalLink = Schema.Struct({
  provider: Schema.Literal("jira"),
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
  workflowId: NullableString,
  labels: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
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

export const HarnessDetection = Schema.Struct({
  id: HarnessId,
  installed: Schema.Boolean,
  authenticated: Schema.optional(Schema.Boolean),
  version: Schema.optional(Schema.String),
  binary: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String)
})
export type HarnessDetection = typeof HarnessDetection.Type

export const JiraConnection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  deployment: Schema.Literals(["cloud", "datacenter"]),
  baseUrl: Schema.String,
  principal: Schema.String,
  jql: Schema.String,
  projectId: Schema.String,
  pollIntervalSec: Schema.Number,
  enabled: Schema.Boolean,
  hasCredential: Schema.Boolean,
  lastSyncAt: NullableString,
  lastFullSyncAt: NullableString,
  lastError: NullableString,
  createdAt: Schema.String
})
export type JiraConnection = typeof JiraConnection.Type

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
