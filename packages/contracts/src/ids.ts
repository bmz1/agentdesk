import { Schema } from "effect"

export const HarnessId = Schema.Literals(["claude", "codex", "opencode", "mock"])
export type HarnessId = typeof HarnessId.Type

export const BoardStatus = Schema.Literals(["todo", "in_progress", "in_review", "blocked", "done"])
export type BoardStatus = typeof BoardStatus.Type
export const BOARD_STATUSES: ReadonlyArray<BoardStatus> = ["todo", "in_progress", "in_review", "blocked", "done"]

export const Priority = Schema.Literals(["none", "low", "medium", "high", "urgent"])
export type Priority = typeof Priority.Type

export const TicketSource = Schema.Literals(["local", "jira"])
export type TicketSource = typeof TicketSource.Type

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

export const PermissionMode = Schema.Literals(["ask", "accept_edits", "plan", "unrestricted"])
export type PermissionMode = typeof PermissionMode.Type
