import type { AgentEvent, AgentQuestion, PlanItem, RateLimitWindow, TokenUsage } from "@agentdesk/contracts"
import { extractImages, imageEvents, isRecord, num, str, type Normalizer } from "@agentdesk/harness-core"

/** Server→client JSON-RPC requests that wait for the user: approvals and questions. */
export const APPROVAL_METHODS: Record<string, { tool: string; legacy: boolean; kind: "tool" | "question"; edit?: boolean }> = {
  "item/commandExecution/requestApproval": { tool: "Bash", legacy: false, kind: "tool" },
  "item/fileChange/requestApproval": { tool: "Edit", legacy: false, kind: "tool", edit: true },
  execCommandApproval: { tool: "Bash", legacy: true, kind: "tool" },
  applyPatchApproval: { tool: "Edit", legacy: true, kind: "tool", edit: true },
  "item/tool/requestUserInput": { tool: "AskUserQuestion", legacy: false, kind: "question" }
}

const PLAN_STATUS: Record<string, PlanItem["status"]> = { pending: "pending", inProgress: "in_progress", completed: "completed" }

/** `request_user_input` questions → canonical questions (answers are keyed by the question id). */
export const codexQuestions = (params: Record<string, unknown>): Array<AgentQuestion> =>
  (Array.isArray(params.questions) ? params.questions.filter(isRecord) : []).flatMap((q) => {
    const id = str(q.id)
    const question = str(q.question)
    if (!id || !question) return []
    const options = (Array.isArray(q.options) ? q.options.filter(isRecord) : []).flatMap((o) =>
      str(o.label) ? [{ label: str(o.label)!, ...(str(o.description) && { description: str(o.description) }) }] : []
    )
    return [{ id, ...(str(q.header) && { header: str(q.header) }), question, options, multiSelect: false, allowOther: q.isOther === true || options.length === 0 }]
  })

const windowLabel = (mins: number | undefined, fallback: string) =>
  mins === 300 ? "5-hour" : mins === 10080 ? "Weekly" : mins ? (mins % 1440 === 0 ? `${mins / 1440}-day` : `${Math.round(mins / 60)}-hour`) : fallback

/** A Codex rate-limit snapshot → windows. `resetsAt` is in seconds since the epoch. */
export const codexRateLimits = (snapshot: unknown): { windows: Array<RateLimitWindow>; limited: boolean } | undefined => {
  if (!isRecord(snapshot)) return undefined
  const windows = (["primary", "secondary"] as const).flatMap((id) => {
    const w = isRecord(snapshot[id]) ? (snapshot[id] as Record<string, unknown>) : undefined
    const used = w ? num(w.usedPercent) : undefined
    if (!w || used === undefined) return []
    const resets = num(w.resetsAt)
    return [
      {
        id,
        label: windowLabel(num(w.windowDurationMins), id),
        usedPercent: used,
        ...(resets !== undefined && { resetsAt: new Date(resets < 1e12 ? resets * 1000 : resets).toISOString() })
      }
    ]
  })
  return windows.length ? { windows, limited: snapshot.rateLimitReachedType != null } : undefined
}

const tokenTotals = (u: unknown) => {
  const t = isRecord(u) && isRecord(u.total) ? u.total : undefined
  if (!t) return undefined
  return {
    input: num(t.inputTokens) ?? 0,
    cached: num(t.cachedInputTokens) ?? 0,
    cacheWrite: num(t.cacheWriteInputTokens) ?? 0,
    output: num(t.outputTokens) ?? 0,
    reasoning: num(t.reasoningOutputTokens) ?? 0
  }
}
type Totals = NonNullable<ReturnType<typeof tokenTotals>>

/**
 * Normalizes `codex app-server` JSON-RPC notifications and approval requests
 * into canonical events. Tracks the active thread/turn for interrupts.
 */
export class CodexNormalizer implements Normalizer {
  threadId: string | undefined
  activeTurnId: string | undefined
  private fileChanges = new Map<string, string>()
  /** Thread token totals, now and when the current turn began: a turn's usage is the difference. */
  private totals: Totals | undefined
  private turnStartTotals: Totals | undefined
  private limits = new Map<string, RateLimitWindow>()

  push(msg: unknown): ReadonlyArray<AgentEvent> {
    if (!isRecord(msg)) return []
    const method = str(msg.method)
    if (!method) return []
    const params = isRecord(msg.params) ? msg.params : {}
    if (msg.id !== undefined && msg.id !== null) return this.serverRequest(method, String(msg.id), params)
    switch (method) {
      case "thread/started": {
        const thread = isRecord(params.thread) ? params.thread : {}
        this.threadId = str(thread.id) ?? this.threadId
        return [{ type: "session.started", providerSessionId: this.threadId, model: str(thread.model), cwd: str(thread.cwd) }]
      }
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : {}
        this.activeTurnId = str(turn.id) ?? str(params.turnId)
        this.turnStartTotals = this.totals
        return []
      }
      case "turn/plan/updated": {
        const items = (Array.isArray(params.plan) ? params.plan.filter(isRecord) : []).flatMap((p) =>
          str(p.step) ? [{ text: str(p.step)!, status: PLAN_STATUS[str(p.status) ?? ""] ?? ("pending" as const) }] : []
        )
        return [{ type: "plan.updated", items }]
      }
      case "thread/tokenUsage/updated": {
        this.totals = tokenTotals(params.tokenUsage) ?? this.totals
        return []
      }
      case "account/rateLimits/updated":
        return this.rateLimits(params.rateLimits)
      case "item/agentMessage/delta": {
        const delta = str(params.delta)
        return delta ? [{ type: "message.delta", messageId: str(params.itemId), text: delta }] : []
      }
      case "item/started":
        return isRecord(params.item) ? this.itemStarted(params.item) : []
      case "item/completed":
        return isRecord(params.item) ? this.itemCompleted(params.item) : []
      case "turn/completed": {
        const turn = isRecord(params.turn) ? params.turn : {}
        this.activeTurnId = undefined
        const status = str(turn.status)
        const out: Array<AgentEvent> = []
        const error = isRecord(turn.error) ? str(turn.error.message) : undefined
        if (error) out.push({ type: "session.error", message: error })
        const usage = this.turnUsage()
        this.turnStartTotals = this.totals
        out.push({
          type: "turn.completed",
          providerSessionId: this.threadId,
          status: status === "interrupted" ? "interrupted" : status === "failed" ? "error" : "success",
          durationMs: num(turn.durationMs),
          ...(usage && { usage })
        })
        return out
      }
      case "error": {
        const error = isRecord(params.error) ? str(params.error.message) : str(params.message)
        return [{ type: "session.error", message: error ?? "Codex error", recoverable: params.willRetry === true }]
      }
      default:
        return []
    }
  }

  /** Merge a (possibly sparse) rate-limit update into the last known windows. */
  rateLimits(snapshot: unknown): ReadonlyArray<AgentEvent> {
    const parsed = codexRateLimits(snapshot)
    if (!parsed) return []
    for (const w of parsed.windows) this.limits.set(w.id, w)
    return [{ type: "rate_limit", windows: [...this.limits.values()], limited: parsed.limited }]
  }

  private turnUsage(): TokenUsage | undefined {
    if (!this.totals) return undefined
    const base = this.turnStartTotals
    const d = (k: keyof Totals) => Math.max(0, this.totals![k] - (base?.[k] ?? 0))
    // Codex counts cached input inside input; report the uncached part as input, like the other harnesses.
    return {
      inputTokens: Math.max(0, d("input") - d("cached")),
      outputTokens: d("output"),
      cacheReadTokens: d("cached"),
      ...(d("cacheWrite") && { cacheWriteTokens: d("cacheWrite") }),
      ...(d("reasoning") && { reasoningTokens: d("reasoning") })
    }
  }

  private serverRequest(method: string, id: string, params: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const spec = APPROVAL_METHODS[method]
    if (!spec) return []
    if (spec.kind === "question") {
      const questions = codexQuestions(params)
      return [
        {
          type: "approval.requested",
          approvalId: id,
          providerRequestId: id,
          toolName: spec.tool,
          kind: "question",
          questions,
          summary: questions.length === 1 ? questions[0]!.question : `${questions.length} questions`,
          details: { input: params }
        }
      ]
    }
    const command = Array.isArray(params.command) ? params.command.join(" ") : str(params.command)
    const files = this.fileChanges.get(str(params.itemId) ?? "")
    const detail = command ?? files ?? str(params.reason) ?? spec.tool
    return [
      {
        type: "approval.requested",
        approvalId: id,
        providerRequestId: id,
        toolName: spec.tool,
        summary: `${spec.tool}: ${detail}`,
        details: { input: command ? { command, cwd: params.cwd } : params, reason: params.reason },
        canAllowForSession: true
      }
    ]
  }

  private itemStarted(item: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const id = str(item.id) ?? "item"
    switch (item.type) {
      case "commandExecution":
        return [{ type: "tool.started", toolCallId: id, name: "Bash", input: { command: item.command, cwd: item.cwd } }]
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
        this.fileChanges.set(id, changes.map((c) => str(c.path)).filter(Boolean).join(", "))
        return [
          {
            type: "tool.started",
            toolCallId: id,
            name: "Edit",
            input: { files: changes.map((c) => ({ path: c.path, kind: isRecord(c.kind) ? c.kind.type : c.kind })) }
          }
        ]
      }
      case "mcpToolCall":
        return [{ type: "tool.started", toolCallId: id, name: `${str(item.server)}.${str(item.tool)}`, input: item.arguments }]
      case "webSearch":
        return [{ type: "tool.started", toolCallId: id, name: "WebSearch", input: { query: item.query } }]
      default:
        return []
    }
  }

  private itemCompleted(item: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const id = str(item.id) ?? "item"
    switch (item.type) {
      case "agentMessage":
        return str(item.text) ? [{ type: "message.completed", messageId: id, text: str(item.text)! }] : []
      case "reasoning": {
        const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])]
        const text = parts.filter((p) => typeof p === "string").join("\n").trim()
        return text ? [{ type: "reasoning", text }] : []
      }
      case "commandExecution":
        return [
          {
            type: "tool.completed",
            toolCallId: id,
            result: str(item.aggregatedOutput) ?? "",
            isError: (num(item.exitCode) ?? 0) !== 0 || item.status === "failed" || item.status === "declined"
          }
        ]
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : []
        return [
          {
            type: "tool.completed",
            toolCallId: id,
            result: changes.map((c) => str(c.diff) ?? str(c.path)).join("\n"),
            isError: item.status === "failed" || item.status === "declined"
          }
        ]
      }
      case "mcpToolCall": {
        const { rest, images } = extractImages(item.result)
        return [{ type: "tool.completed", toolCallId: id, result: item.error ?? rest, isError: !!item.error }, ...imageEvents(images, id)]
      }
      case "imageView":
        return str(item.path) ? [{ type: "image", toolCallId: id, source: { path: str(item.path)! } }] : []
      case "webSearch":
        return [{ type: "tool.completed", toolCallId: id, result: item.query }]
      default:
        return []
    }
  }
}
