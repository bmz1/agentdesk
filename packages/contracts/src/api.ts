import { Schema } from "effect"
import { ApprovalDecision, BoardStatus, GitProvider, HarnessId, PermissionMode, Priority } from "./ids"

/** Request bodies validated at the HTTP boundary. */

export const CreateProjectBody = Schema.Struct({
  name: Schema.NonEmptyString,
  key: Schema.optional(Schema.String),
  repoPath: Schema.NonEmptyString,
  defaultBranch: Schema.optional(Schema.String),
  gitProvider: Schema.optional(GitProvider),
  defaultHarness: Schema.optional(HarnessId),
  defaultWorkflowId: Schema.optional(Schema.NullOr(Schema.String)),
  permissionMode: Schema.optional(PermissionMode),
  testCommand: Schema.optional(Schema.NullOr(Schema.String))
})
export type CreateProjectBody = typeof CreateProjectBody.Type

export const UpdateProjectBody = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  repoPath: Schema.optional(Schema.NonEmptyString),
  defaultBranch: Schema.optional(Schema.String),
  gitProvider: Schema.optional(GitProvider),
  defaultHarness: Schema.optional(HarnessId),
  defaultWorkflowId: Schema.optional(Schema.NullOr(Schema.String)),
  permissionMode: Schema.optional(PermissionMode),
  testCommand: Schema.optional(Schema.NullOr(Schema.String))
})
export type UpdateProjectBody = typeof UpdateProjectBody.Type

export const CreateTicketBody = Schema.Struct({
  projectId: Schema.String,
  title: Schema.NonEmptyString,
  description: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.String),
  status: Schema.optional(BoardStatus),
  priority: Schema.optional(Priority),
  harness: Schema.optional(Schema.NullOr(HarnessId)),
  workflowId: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.Array(Schema.String))
})
export type CreateTicketBody = typeof CreateTicketBody.Type

export const UpdateTicketBody = Schema.Struct({
  title: Schema.optional(Schema.NonEmptyString),
  description: Schema.optional(Schema.String),
  acceptanceCriteria: Schema.optional(Schema.String),
  status: Schema.optional(BoardStatus),
  priority: Schema.optional(Priority),
  harness: Schema.optional(Schema.NullOr(HarnessId)),
  workflowId: Schema.optional(Schema.NullOr(Schema.String)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  pinned: Schema.optional(Schema.Boolean),
  sortOrder: Schema.optional(Schema.Number),
  projectId: Schema.optional(Schema.String)
})
export type UpdateTicketBody = typeof UpdateTicketBody.Type

export const StartSessionBody = Schema.Struct({
  harness: Schema.optional(HarnessId),
  prompt: Schema.optional(Schema.String),
  /** When true, run in the project repo itself instead of a fresh worktree. */
  useRepoDirectly: Schema.optional(Schema.Boolean)
})
export type StartSessionBody = typeof StartSessionBody.Type

export const StartRunBody = Schema.Struct({
  workflowId: Schema.optional(Schema.String),
  harness: Schema.optional(HarnessId)
})
export type StartRunBody = typeof StartRunBody.Type

export const PromptBody = Schema.Struct({ text: Schema.NonEmptyString })
export type PromptBody = typeof PromptBody.Type

export const ApprovalDecisionBody = Schema.Struct({
  decision: ApprovalDecision,
  note: Schema.optional(Schema.String)
})
export type ApprovalDecisionBody = typeof ApprovalDecisionBody.Type

export const CreateJiraConnectionBody = Schema.Struct({
  name: Schema.NonEmptyString,
  deployment: Schema.Literals(["cloud", "datacenter"]),
  baseUrl: Schema.NonEmptyString,
  principal: Schema.String,
  /** API token (Cloud) or PAT (Data Center). Stored in the OS credential store, never SQLite. */
  token: Schema.optional(Schema.String),
  jql: Schema.NonEmptyString,
  projectId: Schema.String,
  pollIntervalSec: Schema.optional(Schema.Number)
})
export type CreateJiraConnectionBody = typeof CreateJiraConnectionBody.Type

export const UpdateJiraConnectionBody = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyString),
  jql: Schema.optional(Schema.NonEmptyString),
  principal: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  pollIntervalSec: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean)
})
export type UpdateJiraConnectionBody = typeof UpdateJiraConnectionBody.Type

export const SaveWorkflowBody = Schema.Struct({ yaml: Schema.NonEmptyString })
export type SaveWorkflowBody = typeof SaveWorkflowBody.Type

export const ApiErrorBody = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Unknown)
})
export type ApiErrorBody = typeof ApiErrorBody.Type

/** Live board/run invalidation notifications sent over `GET /events`. */
export const ChangeNotice = Schema.Struct({
  topic: Schema.Literals(["tickets", "projects", "runs", "sessions", "approvals", "activity", "jira", "workflows"]),
  ticketId: Schema.optional(Schema.String),
  runId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String)
})
export type ChangeNotice = typeof ChangeNotice.Type
