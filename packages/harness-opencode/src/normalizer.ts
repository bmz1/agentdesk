import type { AgentEvent, PlanItem, TokenUsage } from "@agentdesk/contracts"
import { asInlineImage, imageEvents, isRecord, num, str } from "@agentdesk/harness-core"
import { formQuestions } from "./protocol"

/** An OpenCode v2 bus event, as `GET /api/event` sends it. */
export interface OpenCodeEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** Decode one SSE `data:` payload. Unknown or malformed events are skipped, never fatal. */
export const parseEvent = (raw: string): OpenCodeEvent | undefined => {
  try {
    let v: unknown = JSON.parse(raw)
    if (typeof v === "string") v = JSON.parse(v)
    return isRecord(v) && typeof v.type === "string" ? { type: v.type, data: isRecord(v.data) ? v.data : {} } : undefined
  } catch {
    return undefined
  }
}

const PLAN_STATUSES: ReadonlyArray<PlanItem["status"]> = ["pending", "in_progress", "completed", "cancelled"]

/** A request the user answers on a session: its own, or a subagent's. */
export interface PendingRequest {
  readonly kind: "permission" | "form"
  readonly sessionID: string
  /** The form, kept to turn labels back into field values. */
  readonly form?: unknown
}

const usageOf = (tokens: unknown): TokenUsage | undefined => {
  if (!isRecord(tokens)) return undefined
  const cache = isRecord(tokens.cache) ? tokens.cache : {}
  return {
    inputTokens: num(tokens.input) ?? 0,
    outputTokens: num(tokens.output) ?? 0,
    cacheReadTokens: num(cache.read) ?? 0,
    cacheWriteTokens: num(cache.write) ?? 0,
    reasoningTokens: num(tokens.reasoning) ?? 0
  }
}

const textOf = (content: unknown) =>
  (Array.isArray(content) ? content.filter(isRecord) : []).flatMap((c) => (c.type === "text" && str(c.text) ? [str(c.text)!] : [])).join("\n")

/**
 * Normalizes OpenCode v2 bus events for one session. Its subagents' sessions are followed too, but only
 * for what needs the user (permissions and forms); their text and tools stay inside the subagent.
 */
export class OpenCodeNormalizer {
  private readonly sessions = new Set<string>()
  private toolNames = new Map<string, string>()
  private toolsStarted = new Set<string>()
  private busySince = 0
  private steps: Array<{ usage: TokenUsage; cost: number | undefined }> = []
  private model: string | undefined
  /** Open permission and form requests by id: replies go to the session that asked. */
  readonly pending = new Map<string, PendingRequest>()

  constructor(public readonly sessionId: string) {
    this.sessions.add(sessionId)
  }

  push(e: OpenCodeEvent): ReadonlyArray<AgentEvent> {
    const d = e.data
    const sid = str(d.sessionID)
    if (e.type === "session.created" && sid && this.sessions.has(str(d.parentID) ?? "")) this.sessions.add(sid)
    // A form names its session inside the form.
    if (e.type === "form.created") return this.form(d.form)
    if (!sid || !this.sessions.has(sid)) return []
    const own = sid === this.sessionId
    switch (e.type) {
      case "permission.asked":
        return this.permission(d, sid)
      case "permission.replied":
        this.pending.delete(str(d.requestID) ?? "")
        return []
      case "form.replied":
      case "form.cancelled":
        this.pending.delete(str(d.id) ?? "")
        return []
    }
    if (!own) return []
    switch (e.type) {
      case "session.execution.started":
        this.busySince = Date.now()
        this.steps = []
        return []
      case "session.step.started": {
        const m = isRecord(d.model) ? d.model : {}
        if (str(m.providerID) && str(m.id)) this.model = `${str(m.providerID)}/${str(m.id)}`
        return []
      }
      case "session.step.ended":
      case "session.step.failed": {
        const usage = usageOf(d.tokens)
        if (usage) this.steps.push({ usage, cost: num(d.cost) })
        return []
      }
      case "session.text.delta": {
        const delta = str(d.delta)
        return delta ? [{ type: "message.delta", messageId: `${str(d.assistantMessageID)}:${num(d.ordinal) ?? 0}`, text: delta }] : []
      }
      case "session.text.ended":
        return [{ type: "message.completed", messageId: `${str(d.assistantMessageID)}:${num(d.ordinal) ?? 0}`, text: str(d.text) ?? "" }]
      case "session.reasoning.ended":
        return str(d.text) ? [{ type: "reasoning", text: str(d.text)! }] : []
      case "session.tool.input.started": {
        const id = str(d.id)
        if (id && str(d.name)) this.toolNames.set(id, str(d.name)!)
        return []
      }
      case "session.tool.called":
        return this.toolCalled(d)
      case "session.tool.success":
      case "session.tool.failed": {
        const id = str(d.id)
        if (!id) return []
        const failed = e.type === "session.tool.failed"
        const error = isRecord(d.error) ? str(d.error.message) : undefined
        const images = (Array.isArray(d.content) ? d.content : []).flatMap((c) => {
          // Tools attach files (screenshots, images they read) as data URIs.
          const url = isRecord(c) ? str(c.uri) : undefined
          return asInlineImage(isRecord(c) && url ? { type: "file", url } : undefined) ?? []
        })
        return [
          ...(this.toolsStarted.has(id) ? [] : [{ type: "tool.started" as const, toolCallId: id, name: this.toolNames.get(id) ?? "tool", input: undefined }]),
          { type: "tool.completed", toolCallId: id, result: failed ? (error ?? textOf(d.content)) : textOf(d.content), isError: failed },
          ...imageEvents(images, id)
        ]
      }
      case "session.execution.succeeded":
        return [this.turn("success")]
      case "session.execution.interrupted":
        return [this.turn("interrupted")]
      case "session.execution.failed": {
        const error = isRecord(d.error) ? d.error : {}
        return [{ type: "session.error", message: str(error.message) ?? str(error.type) ?? "OpenCode error" }, this.turn("error")]
      }
      default:
        return []
    }
  }

  /** A form: the agent asks the user one or more questions. */
  form(form: unknown): ReadonlyArray<AgentEvent> {
    const f = isRecord(form) ? form : {}
    const id = str(f.id)
    const sid = str(f.sessionID)
    if (!id || !sid || !this.sessions.has(sid)) return []
    const questions = formQuestions(form)
    this.pending.set(id, { kind: "form", sessionID: sid, form })
    return [
      {
        type: "approval.requested",
        approvalId: id,
        providerRequestId: id,
        toolName: "question",
        kind: "question",
        questions,
        summary: questions.length === 1 ? questions[0]!.question : (str(f.title) ?? `${questions.length} questions`),
        details: { input: form }
      }
    ]
  }

  private permission(d: Record<string, unknown>, sid: string): ReadonlyArray<AgentEvent> {
    const id = str(d.id)
    if (!id) return []
    this.pending.set(id, { kind: "permission", sessionID: sid })
    const action = str(d.action) ?? "permission"
    const resources = Array.isArray(d.resources) ? d.resources.filter((r): r is string => typeof r === "string") : []
    const save = Array.isArray(d.save) ? d.save : []
    return [
      {
        type: "approval.requested",
        approvalId: id,
        providerRequestId: id,
        toolName: action,
        summary: resources.length ? `${action}: ${resources.join(" ")}` : action,
        details: { input: d.metadata, resources, save, ...(sid !== this.sessionId && { subagentSession: sid }) },
        // `save` lists the patterns an "always" reply would allow from now on.
        canAllowForSession: save.length > 0
      }
    ]
  }

  private toolCalled(d: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const id = str(d.id)
    if (!id || this.toolsStarted.has(id)) return []
    this.toolsStarted.add(id)
    const name = this.toolNames.get(id) ?? "tool"
    const input = d.input
    const out: Array<AgentEvent> = [{ type: "tool.started", toolCallId: id, name, input }]
    // The todo tool carries the agent's plan.
    const todos = isRecord(input) && Array.isArray(input.todos) ? input.todos.filter(isRecord) : undefined
    if (todos && /todo/i.test(name)) {
      out.push({
        type: "plan.updated",
        items: todos.flatMap((t) => {
          const text = str(t.content) ?? str(t.text)
          if (!text) return []
          const status = PLAN_STATUSES.includes(str(t.status) as PlanItem["status"]) ? (str(t.status) as PlanItem["status"]) : "pending"
          return [{ text, status }]
        })
      })
    }
    return out
  }

  private turn(status: "success" | "error" | "interrupted"): AgentEvent {
    const steps = this.steps
    this.steps = []
    const sum = (k: keyof TokenUsage) => steps.reduce((n, s) => n + (s.usage[k] ?? 0), 0)
    const costs = steps.map((s) => s.cost).filter((c): c is number => c !== undefined)
    return {
      type: "turn.completed",
      providerSessionId: this.sessionId,
      status,
      durationMs: this.busySince ? Date.now() - this.busySince : 0,
      ...(steps.length > 0 && {
        usage: {
          inputTokens: sum("inputTokens"),
          outputTokens: sum("outputTokens"),
          cacheReadTokens: sum("cacheReadTokens"),
          cacheWriteTokens: sum("cacheWriteTokens"),
          ...(sum("reasoningTokens") && { reasoningTokens: sum("reasoningTokens") })
        }
      }),
      ...(costs.length > 0 && { costUsd: costs.reduce((a, b) => a + b, 0) }),
      ...(this.model && { model: this.model })
    }
  }
}
