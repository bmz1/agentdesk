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
export const ApprovalRequestedEvent = ev("approval.requested", {
  approvalId: Schema.String,
  /** The provider-specific request id needed to answer the harness. */
  providerRequestId: Schema.optional(Schema.String),
  toolName: Schema.String,
  summary: Schema.String,
  details: Schema.optional(Schema.Unknown)
})
export const ApprovalResolvedEvent = ev("approval.resolved", {
  approvalId: Schema.String,
  decision: Schema.Literals(["allow", "deny"])
})
export const TurnCompletedEvent = ev("turn.completed", {
  providerSessionId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["success", "error", "interrupted"])),
  costUsd: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.String)
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
  ImageEvent
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
