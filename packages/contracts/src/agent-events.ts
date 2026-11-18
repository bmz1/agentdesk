import { Schema } from "effect"

/**
 * Canonical, harness-agnostic agent events. Every adapter normalizes its native
 * protocol into this union; the daemon persists them verbatim (validated) into
 * the durable event log and fans them out over SSE.
 */
const ev = <T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), ...fields })

/** An image held in the daemon's attachment store (`GET /attachments/:id`). */
export const ImageRef = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  name: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number)
})
export type ImageRef = typeof ImageRef.Type

export const SessionStartedEvent = ev("session.started", {
  providerSessionId: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String)
})
export const UserPromptEvent = ev("user.prompt", { text: Schema.String, images: Schema.optional(Schema.Array(ImageRef)) })
export const MessageDeltaEvent = ev("message.delta", {
  messageId: Schema.optional(Schema.String),
  text: Schema.String
})
export const MessageCompletedEvent = ev("message.completed", {
  messageId: Schema.optional(Schema.String),
  text: Schema.String
})
export const ReasoningEvent = ev("reasoning", { text: Schema.String })
export const ToolStartedEvent = ev("tool.started", {
  toolCallId: Schema.String,
  name: Schema.String,
  input: Schema.optional(Schema.Unknown)
})
export const ToolCompletedEvent = ev("tool.completed", {
  toolCallId: Schema.String,
  result: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean)
})
/** One question an agent asks the user (Claude AskUserQuestion, Codex request_user_input, OpenCode question). */
export const AgentQuestion = Schema.Struct({
  /** Key the answer is returned under. */
  id: Schema.String,
  header: Schema.optional(Schema.String),
  question: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) })),
  multiSelect: Schema.Boolean,
  /** A free-text answer is accepted besides the options. */
  allowOther: Schema.Boolean
})
export type AgentQuestion = typeof AgentQuestion.Type

/** Answers keyed by question id; each holds the chosen option labels or free text. */
export const QuestionAnswers = Schema.Record(Schema.String, Schema.Array(Schema.String))
export type QuestionAnswers = typeof QuestionAnswers.Type

export const ApprovalRequestedEvent = ev("approval.requested", {
  approvalId: Schema.String,
  /** The provider-specific request id needed to answer the harness. */
  providerRequestId: Schema.optional(Schema.String),
  toolName: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.Unknown),
  /** "question": the agent asks the user something; answer with `questions`' ids. Default "tool". */
  kind: Schema.optional(Schema.Literals(["tool", "question"])),
  questions: Schema.optional(Schema.Array(AgentQuestion)),
  /** The harness can remember an "allow" for the rest of the session. */
  canAllowForSession: Schema.optional(Schema.Boolean)
})
export const ApprovalResolvedEvent = ev("approval.resolved", {
  approvalId: Schema.String,
  decision: Schema.Literals(["allow", "deny"]),
  scope: Schema.optional(Schema.Literals(["once", "session"])),
  answers: Schema.optional(QuestionAnswers)
})

/** The agent's current plan or to-do list (Claude TodoWrite/Task tools, Codex plan, OpenCode todos). Replaces the last one. */
export const PlanItem = Schema.Struct({
  text: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"])
})
export type PlanItem = typeof PlanItem.Type
export const PlanUpdatedEvent = ev("plan.updated", { items: Schema.Array(PlanItem) })

/** Tokens a turn used. Cached reads are part of the input the model saw but bill differently. */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  reasoningTokens: Schema.optional(Schema.Number)
})
export type TokenUsage = typeof TokenUsage.Type

/** A subscription rate-limit window (Claude's 5-hour/7-day, Codex's primary/secondary). */
export const RateLimitWindow = Schema.Struct({
  /** Stable key, e.g. "five_hour", "seven_day", "primary". */
  id: Schema.String,
  label: Schema.String,
  /** 0–100. */
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String)
})
export type RateLimitWindow = typeof RateLimitWindow.Type
/** Latest account limits the harness reported. Kept per harness by the daemon, not stored in the transcript. */
export const RateLimitEvent = ev("rate_limit", {
  windows: Schema.Array(RateLimitWindow),
  /** True when the harness says the account is currently limited. */
  limited: Schema.optional(Schema.Boolean)
})
export const TurnCompletedEvent = ev("turn.completed", {
  providerSessionId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["success", "error", "interrupted"])),
  /** Cost of this turn alone. */
  costUsd: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.String),
  usage: Schema.optional(TokenUsage),
  /** The model that answered, when the harness says. */
  model: Schema.optional(Schema.String)
})
export const SessionStatusEvent = ev("session.status", {
  state: Schema.String,
  detail: Schema.optional(Schema.String)
})
export const SessionErrorEvent = ev("session.error", {
  message: Schema.String,
  recoverable: Schema.optional(Schema.Boolean)
})
/**
 * An image the agent produced or looked at (screenshots, viewed files). Adapters emit
 * `source` (inline base64 or a local path); the daemon stores it and persists only `image`.
 */
export const ImageEvent = ev("image", {
  toolCallId: Schema.optional(Schema.String),
  image: Schema.optional(ImageRef),
  source: Schema.optional(
    Schema.Struct({
      data: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
      mimeType: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String)
    })
  )
})

export const SessionExitedEvent = ev("session.exited", {
  code: Schema.optional(Schema.NullOr(Schema.Number)),
  signal: Schema.optional(Schema.NullOr(Schema.String))
})

export const AgentEvent = Schema.Union([
  SessionStartedEvent,
  UserPromptEvent,
  MessageDeltaEvent,
  MessageCompletedEvent,
  ReasoningEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  TurnCompletedEvent,
  SessionStatusEvent,
  SessionErrorEvent,
  SessionExitedEvent,
  ImageEvent,
  PlanUpdatedEvent,
  RateLimitEvent
])
export type AgentEvent = typeof AgentEvent.Type
export type AgentEventType = AgentEvent["type"]

/** A persisted agent event with its durable, monotonic id. */
export const StoredAgentEvent = Schema.Struct({
  id: Schema.Number,
  sessionId: Schema.String,
  at: Schema.String,
  event: AgentEvent
})
export type StoredAgentEvent = typeof StoredAgentEvent.Type
