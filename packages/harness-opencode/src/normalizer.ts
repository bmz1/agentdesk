import type { AgentEvent, AgentQuestion, PlanItem, TokenUsage } from "@agentdesk/contracts"
import { asInlineImage, imageEvents, isRecord, num, str, type Normalizer } from "@agentdesk/harness-core"

const PLAN_STATUSES: ReadonlyArray<PlanItem["status"]> = ["pending", "in_progress", "completed", "cancelled"]

/** OpenCode questions → canonical ones. Answers go back as a list in question order, so ids are indexes. */
export const openCodeQuestions = (questions: unknown): Array<AgentQuestion> =>
  (Array.isArray(questions) ? questions.filter(isRecord) : []).flatMap((q, i) => {
    const question = str(q.question)
    if (!question) return []
    const options = (Array.isArray(q.options) ? q.options.filter(isRecord) : []).flatMap((o) =>
      str(o.label) ? [{ label: str(o.label)!, ...(str(o.description) && { description: str(o.description) }) }] : []
    )
    return [{ id: String(i), ...(str(q.header) && { header: str(q.header) }), question, options, multiSelect: q.multiple === true, allowOther: q.custom !== false }]
  })

interface MessageUsage {
  readonly usage: TokenUsage
  readonly cost: number | undefined
  readonly model: string | undefined
}

/**
 * Normalizes `opencode serve` bus events (GET /event) for one OpenCode session.
 * Events for other sessions on the same server are ignored.
 */
export class OpenCodeNormalizer implements Normalizer {
  private roles = new Map<string, string>()
  private toolsStarted = new Set<string>()
  private toolsDone = new Set<string>()
  private finishedParts = new Set<string>()
  private aborted = false
  private errored = false
  private busy = false
  private busySince = 0
  /** Completed assistant messages of the current turn, by id (updates repeat). */
  private turnMessages = new Map<string, MessageUsage>()
  /** Pending question request ids: they are answered on a different endpoint than permissions. */
  readonly questionIds = new Set<string>()

  constructor(public sessionId: string) {}

  /** Mark that a prompt was sent so the next idle reports a completed turn. */
  markBusy() {
    if (!this.busy) {
      this.busySince = Date.now()
      this.turnMessages.clear()
    }
    this.busy = true
  }

  push(msg: unknown): ReadonlyArray<AgentEvent> {
    if (!isRecord(msg) || !isRecord(msg.properties)) return []
    const p = msg.properties
    const sid = str(p.sessionID) ?? (isRecord(p.part) ? str(p.part.sessionID) : undefined) ?? (isRecord(p.info) ? str(p.info.sessionID) : undefined)
    if (sid !== this.sessionId) return []
    switch (msg.type) {
      case "message.updated": {
        const info = isRecord(p.info) ? p.info : {}
        const id = str(info.id)
        if (id && str(info.role)) this.roles.set(id, str(info.role)!)
        const time = isRecord(info.time) ? info.time : {}
        if (id && info.role === "assistant" && time.completed !== undefined && isRecord(info.tokens)) {
          const t = info.tokens
          const cache = isRecord(t.cache) ? t.cache : {}
          this.turnMessages.set(id, {
            usage: {
              inputTokens: num(t.input) ?? 0,
              outputTokens: num(t.output) ?? 0,
              cacheReadTokens: num(cache.read) ?? 0,
              cacheWriteTokens: num(cache.write) ?? 0,
              reasoningTokens: num(t.reasoning) ?? 0
            },
            cost: num(info.cost),
            model: str(info.providerID) && str(info.modelID) ? `${str(info.providerID)}/${str(info.modelID)}` : undefined
          })
        }
        return []
      }
      case "message.part.delta": {
        if (p.field !== "text" || this.roles.get(str(p.messageID) ?? "") === "user") return []
        const delta = str(p.delta)
        return delta ? [{ type: "message.delta", messageId: str(p.partID), text: delta }] : []
      }
      case "message.part.updated":
        return isRecord(p.part) ? this.part(p.part, str(p.delta)) : []
      case "permission.asked":
      case "permission.updated": {
        const id = str(p.id)
        if (!id) return []
        const permission = str(p.permission) ?? str(p.type) ?? "permission"
        const patterns = Array.isArray(p.patterns) ? p.patterns.join(" ") : (str(p.pattern) ?? str(p.title) ?? "")
        return [
          {
            type: "approval.requested",
            approvalId: id,
            providerRequestId: id,
            toolName: permission,
            summary: patterns ? `${permission}: ${patterns}` : permission,
            details: { input: p.metadata, patterns: p.patterns, always: p.always },
            // `always` lists the patterns an "always" reply would allow for the session.
            canAllowForSession: Array.isArray(p.always) && p.always.length > 0
          }
        ]
      }
      case "question.asked":
      case "question.v2.asked": {
        const id = str(p.id)
        if (!id) return []
        this.questionIds.add(id)
        const questions = openCodeQuestions(p.questions)
        return [
          {
            type: "approval.requested",
            approvalId: id,
            providerRequestId: id,
            toolName: "question",
            kind: "question",
            questions,
            summary: questions.length === 1 ? questions[0]!.question : `${questions.length} questions`,
            details: { input: p.questions }
          }
        ]
      }
      case "todo.updated": {
        const items = (Array.isArray(p.todos) ? p.todos.filter(isRecord) : []).flatMap((t) => {
          const text = str(t.content)
          if (!text) return []
          const status = PLAN_STATUSES.includes(str(t.status) as PlanItem["status"]) ? (str(t.status) as PlanItem["status"]) : "pending"
          return [{ text, status }]
        })
        return [{ type: "plan.updated", items }]
      }
      case "permission.v2.asked": {
        const id = str(p.id)
        if (!id) return []
        const action = str(p.action) ?? "permission"
        const resources = Array.isArray(p.resources) ? p.resources.join(" ") : ""
        return [
          {
            type: "approval.requested",
            approvalId: id,
            providerRequestId: id,
            toolName: action,
            summary: resources ? `${action}: ${resources}` : action,
            details: { input: p.metadata, resources: p.resources },
            canAllowForSession: Array.isArray(p.save) && p.save.length > 0
          }
        ]
      }
      case "session.error": {
        const err = isRecord(p.error) ? p.error : {}
        if (str(err.name) === "MessageAbortedError") {
          this.aborted = true
          return []
        }
        const data = isRecord(err.data) ? err.data : {}
        this.errored = true
        return [{ type: "session.error", message: str(data.message) ?? str(err.name) ?? "OpenCode error" }]
      }
      case "session.idle": {
        if (!this.busy) return []
        this.busy = false
        const status = this.aborted ? "interrupted" : this.errored ? "error" : "success"
        this.aborted = false
        this.errored = false
        const messages = [...this.turnMessages.values()]
        this.turnMessages.clear()
        const sum = (k: keyof TokenUsage) => messages.reduce((n, m) => n + (m.usage[k] ?? 0), 0)
        const costs = messages.map((m) => m.cost).filter((c): c is number => c !== undefined)
        const model = messages.at(-1)?.model
        return [
          {
            type: "turn.completed",
            providerSessionId: this.sessionId,
            status,
            durationMs: Date.now() - this.busySince,
            ...(messages.length > 0 && {
              usage: {
                inputTokens: sum("inputTokens"),
                outputTokens: sum("outputTokens"),
                cacheReadTokens: sum("cacheReadTokens"),
                cacheWriteTokens: sum("cacheWriteTokens"),
                ...(sum("reasoningTokens") && { reasoningTokens: sum("reasoningTokens") })
              }
            }),
            ...(costs.length > 0 && { costUsd: costs.reduce((a, b) => a + b, 0) }),
            ...(model && { model })
          }
        ]
      }
      default:
        return []
    }
  }

  private part(part: Record<string, unknown>, delta: string | undefined): ReadonlyArray<AgentEvent> {
    const id = str(part.id) ?? "part"
    const messageRole = this.roles.get(str(part.messageID) ?? "")
    switch (part.type) {
      case "text": {
        if (messageRole === "user" || part.synthetic === true) return []
        const time = isRecord(part.time) ? part.time : {}
        if (time.end !== undefined && !this.finishedParts.has(id)) {
          this.finishedParts.add(id)
          return [{ type: "message.completed", messageId: id, text: str(part.text) ?? "" }]
        }
        return delta ? [{ type: "message.delta", messageId: id, text: delta }] : []
      }
      case "reasoning": {
        const time = isRecord(part.time) ? part.time : {}
        if (time.end === undefined || this.finishedParts.has(id) || !str(part.text)) return []
        this.finishedParts.add(id)
        return [{ type: "reasoning", text: str(part.text)! }]
      }
      case "tool": {
        const callId = str(part.callID) ?? id
        const state = isRecord(part.state) ? part.state : {}
        const out: Array<AgentEvent> = []
        if (!this.toolsStarted.has(callId)) {
          this.toolsStarted.add(callId)
          out.push({ type: "tool.started", toolCallId: callId, name: str(part.tool) ?? "tool", input: state.input })
        }
        if ((state.status === "completed" || state.status === "error") && !this.toolsDone.has(callId)) {
          this.toolsDone.add(callId)
          out.push({
            type: "tool.completed",
            toolCallId: callId,
            result: state.status === "error" ? state.error : state.output,
            isError: state.status === "error"
          })
          // Tools (e.g. screenshots, reading an image) attach files as data URLs.
          const attachments = Array.isArray(state.attachments) ? state.attachments : []
          out.push(...imageEvents(attachments.flatMap((a) => asInlineImage(a) ?? []), callId))
        }
        return out
      }
      default:
        return []
    }
  }
}
