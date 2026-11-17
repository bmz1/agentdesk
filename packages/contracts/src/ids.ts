import { Schema } from "effect"

export const HarnessId = Schema.Literals(["claude", "codex", "opencode", "mock"])
export type HarnessId = typeof HarnessId.Type

export const BoardStatus = Schema.Literals(["todo", "in_progress", "in_review", "blocked", "done"])
export type BoardStatus = typeof BoardStatus.Type
export const BOARD_STATUSES: ReadonlyArray<BoardStatus> = ["todo", "in_progress", "in_review", "blocked", "done"]

export const Priority = Schema.Literals(["none", "low", "medium", "high", "urgent"])
export type Priority = typeof Priority.Type

/**
 * Where a ticket came from: "local" or the id of a registered task source
 * ("jira", "linear", …). Open-ended so new sources need no contract change.
 */
export const TicketSource = Schema.String
export type TicketSource = typeof TicketSource.Type
export const LOCAL_SOURCE = "local"

export const GitProvider = Schema.Literals(["github", "gitlab", "none"])
export type GitProvider = typeof GitProvider.Type

export const SessionState = Schema.Literals([
  "starting",
  "running",
  "idle",
  "waiting_for_approval",
  "completed",
  "failed",
  "interrupted",
  "closed"
])
export type SessionState = typeof SessionState.Type
/** States in which a harness process is (or is about to be) attached to the session. */
export const LIVE_SESSION_STATES: ReadonlyArray<SessionState> = ["starting", "running", "waiting_for_approval", "idle"]

export const RunStatus = Schema.Literals([
  "queued",
  "preparing",
  "running",
  "waiting_for_approval",
  "retrying",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
])
export type RunStatus = typeof RunStatus.Type

export const StepState = Schema.Literals([
  "pending",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "interrupted"
])
export type StepState = typeof StepState.Type

export const ApprovalDecision = Schema.Literals(["allow", "deny"])
export type ApprovalDecision = typeof ApprovalDecision.Type

/**
 * How a ticket's agent works on the repo: in its own worktree from the start, or read-only
 * in the main checkout until the agent itself creates a worktree (which is then adopted).
 */
export const WorkspaceMode = Schema.Literals(["worktree", "readonly"])
export type WorkspaceMode = typeof WorkspaceMode.Type

export const PermissionMode = Schema.Literals(["ask", "accept_edits", "plan", "unrestricted"])
export type PermissionMode = typeof PermissionMode.Type
