import type { AgentEvent, AgentQuestion, PlanItem, RateLimitWindow, TokenUsage } from "@agentdesk/contracts"
import { extractImages, imageEvents, isRecord, num, str, summarizeToolInput, type Normalizer } from "@agentdesk/harness-core"

/** Claude's question tool: answered through the permission request's `updatedInput.answers`. */
export const QUESTION_TOOL = "AskUserQuestion"

const PLAN_STATUSES: ReadonlyArray<PlanItem["status"]> = ["pending", "in_progress", "completed", "cancelled"]
const planStatus = (v: unknown): PlanItem["status"] => {
  const s = str(v)
  return PLAN_STATUSES.includes(s as PlanItem["status"]) ? (s as PlanItem["status"]) : "pending"
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly (Opus)",
  seven_day_sonnet: "Weekly (Sonnet)"
}

/** AskUserQuestion input → canonical questions. Claude keys answers by the question text. */
export const claudeQuestions = (input: unknown): Array<AgentQuestion> => {
  const list = isRecord(input) && Array.isArray(input.questions) ? input.questions.filter(isRecord) : []
  return list.flatMap((q) => {
    const question = str(q.question)
    if (!question) return []
    const options = (Array.isArray(q.options) ? q.options.filter(isRecord) : []).flatMap((o) =>
      str(o.label) ? [{ label: str(o.label)!, ...(str(o.description) && { description: str(o.description) }) }] : []
    )
    return [
      {
        id: question,
        ...(str(q.header) && { header: str(q.header) }),
        question,
        options,
        multiSelect: q.multiSelect === true,
        allowOther: true
      }
    ]
  })
}

/**
 * Normalizes Claude Code `--output-format stream-json --verbose --include-partial-messages`
 * output into canonical events.
 */
export class ClaudeNormalizer implements Normalizer {
  providerSessionId: string | undefined
  /** Set by the adapter when it asks Claude to stop: the turn's error result then means "interrupted". */
  interruptRequested = false
  /** `total_cost_usd` is cumulative over the conversation; turns report the difference. */
  private costSoFar: number | undefined
  /** Claude's Task tools: ids are only known from the TaskCreate result. */
  private tasks = new Map<string, PlanItem>()
  private pendingTaskCreates = new Map<string, string>()

  push(msg: unknown): ReadonlyArray<AgentEvent> {
    if (!isRecord(msg)) return []
    const sid = str(msg.session_id)
    if (sid) this.providerSessionId = sid
    switch (msg.type) {
      case "system":
        return this.system(msg)
      case "stream_event":
        return this.streamEvent(msg)
      case "assistant":
        return this.assistant(msg)
      case "user":
        return this.user(msg)
      case "control_request":
        return this.controlRequest(msg)
      case "result":
        return this.result(msg)
      case "rate_limit_event":
        return this.rateLimit(msg)
      default:
        return []
    }
  }

  private system(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    if (msg.subtype === "init") {
      return [
        {
          type: "session.started",
          providerSessionId: str(msg.session_id),
          model: str(msg.model),
          cwd: str(msg.cwd)
        }
      ]
    }
    if (msg.subtype === "permission_denied") {
      return [{ type: "session.status", state: "permission_denied", detail: str(msg.message) }]
    }
    return []
  }

  private streamEvent(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const ev = msg.event
    if (!isRecord(ev) || ev.type !== "content_block_delta" || !isRecord(ev.delta)) return []
    if (msg.parent_tool_use_id) return [] // sub-agent chatter; surfaced via tool results
    if (ev.delta.type === "text_delta") {
      const text = str(ev.delta.text)
      if (!text) return []
      return [{ type: "message.delta", messageId: str(msg.api_message_id), text }]
    }
    return []
  }

  private assistant(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const message = msg.message
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    if (msg.parent_tool_use_id) return []
    const messageId = str(message.id)
    const out: Array<AgentEvent> = []
    for (const block of message.content) {
      if (!isRecord(block)) continue
      if (block.type === "text" && str(block.text)) {
        out.push({ type: "message.completed", messageId, text: str(block.text)! })
      } else if (block.type === "thinking" && str(block.thinking)) {
        out.push({ type: "reasoning", text: str(block.thinking)! })
      } else if (block.type === "tool_use") {
        const toolCallId = str(block.id) ?? "unknown"
        const name = str(block.name) ?? "tool"
        out.push({ type: "tool.started", toolCallId, name, input: block.input })
        out.push(...this.planFromTool(toolCallId, name, block.input))
      }
    }
    return out
  }

  private user(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const message = msg.message
    if (!isRecord(message) || !Array.isArray(message.content)) return []
    if (msg.parent_tool_use_id) return []
    const out: Array<AgentEvent> = []
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      const toolCallId = str(block.tool_use_id) ?? "unknown"
      // Screenshots and viewed images arrive as base64 blocks inside the result.
      const { rest, images } = extractImages(block.content)
      const result = flattenToolResult(rest)
      out.push({
        type: "tool.completed",
        toolCallId,
        result,
        isError: block.is_error === true
      })
      out.push(...imageEvents(images, toolCallId))
      out.push(...this.taskCreated(toolCallId, result, block.is_error === true))
    }
    return out
  }

  private controlRequest(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const req = msg.request
    const requestId = str(msg.request_id)
    if (!isRecord(req) || !requestId || req.subtype !== "can_use_tool") return []
    const toolName = str(req.tool_name) ?? "tool"
    if (toolName === QUESTION_TOOL) {
      const questions = claudeQuestions(req.input)
      return [
        {
          type: "approval.requested",
          approvalId: requestId,
          providerRequestId: requestId,
          toolName,
          kind: "question",
          questions,
          summary: questions.length === 1 ? questions[0]!.question : `${questions.length} questions`,
          details: { input: req.input, toolUseId: req.tool_use_id }
        }
      ]
    }
    const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []
    return [
      {
        type: "approval.requested",
        approvalId: requestId,
        providerRequestId: requestId,
        toolName,
        summary: str(req.description) ? `${toolName}: ${str(req.description)}` : summarizeToolInput(toolName, req.input),
        details: { input: req.input, toolUseId: req.tool_use_id, blockedPath: req.blocked_path },
        canAllowForSession: suggestions.length > 0
      }
    ]
  }

  private result(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const isError = msg.is_error === true || (str(msg.subtype) ?? "").startsWith("error")
    const interrupted = str(msg.terminal_reason) === "aborted_streaming" || (isError && this.interruptRequested)
    this.interruptRequested = false
    const total = num(msg.total_cost_usd)
    const costUsd = total === undefined ? undefined : Math.max(0, total - (this.costSoFar ?? 0))
    if (total !== undefined) this.costSoFar = total
    const usage = claudeUsage(msg.usage)
    const models = isRecord(msg.modelUsage) ? Object.keys(msg.modelUsage) : []
    return [
      {
        type: "turn.completed",
        providerSessionId: str(msg.session_id),
        status: interrupted ? "interrupted" : isError ? "error" : "success",
        ...(costUsd !== undefined && { costUsd: Math.round(costUsd * 1e6) / 1e6 }),
        durationMs: num(msg.duration_ms),
        summary: str(msg.result),
        ...(usage && { usage }),
        ...(models.length === 1 && { model: models[0] })
      }
    ]
  }

  private rateLimit(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const info = isRecord(msg.rate_limit_info) ? msg.rate_limit_info : undefined
    if (!info) return []
    const windows: Array<RateLimitWindow> = Object.entries(isRecord(info.unifiedWindows) ? info.unifiedWindows : {}).flatMap(([id, w]) => {
      if (!isRecord(w)) return []
      const utilization = num(w.utilization)
      if (utilization === undefined) return []
      const resets = num(w.resetsAt)
      return [
        {
          id,
          label: WINDOW_LABELS[id] ?? id.replace(/_/g, " "),
          usedPercent: Math.round(utilization * 1000) / 10,
          ...(resets !== undefined && { resetsAt: new Date(resets * 1000).toISOString() })
        }
      ]
    })
    return windows.length ? [{ type: "rate_limit", windows, limited: str(info.status) === "rejected" }] : []
  }

  /** TodoWrite carries the whole list; TaskCreate/TaskUpdate change one task at a time. */
  private planFromTool(toolCallId: string, name: string, input: unknown): ReadonlyArray<AgentEvent> {
    if (!isRecord(input)) return []
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      const items = input.todos.filter(isRecord).flatMap((t) => {
        const text = str(t.content) ?? str(t.activeForm)
        return text ? [{ text, status: planStatus(t.status) }] : []
      })
      return [{ type: "plan.updated", items }]
    }
    if (name === "TaskCreate" && str(input.subject)) {
      this.pendingTaskCreates.set(toolCallId, str(input.subject)!)
      return []
    }
    if (name === "TaskUpdate") {
      const id = str(input.taskId) ?? (num(input.taskId) !== undefined ? String(num(input.taskId)) : undefined)
      const task = id ? this.tasks.get(id) : undefined
      if (!id || !task) return []
      if (str(input.status) === "deleted") this.tasks.delete(id)
      else
        this.tasks.set(id, {
          text: str(input.subject) ?? task.text,
          status: input.status === undefined ? task.status : planStatus(input.status)
        })
      return [this.taskPlan()]
    }
    return []
  }

  private taskCreated(toolCallId: string, result: unknown, isError: boolean): ReadonlyArray<AgentEvent> {
    const subject = this.pendingTaskCreates.get(toolCallId)
    if (subject === undefined) return []
    this.pendingTaskCreates.delete(toolCallId)
    const id = typeof result === "string" ? /#(\d+)/.exec(result)?.[1] : undefined
    if (isError || !id) return []
    this.tasks.set(id, { text: subject, status: "pending" })
    return [this.taskPlan()]
  }

  private taskPlan(): AgentEvent {
    return { type: "plan.updated", items: [...this.tasks.values()] }
  }
}

const claudeUsage = (u: unknown): TokenUsage | undefined => {
  if (!isRecord(u)) return undefined
  const inputTokens = num(u.input_tokens)
  const outputTokens = num(u.output_tokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const details = isRecord(u.output_tokens_details) ? u.output_tokens_details : {}
  return {
    inputTokens,
    outputTokens,
    ...(num(u.cache_read_input_tokens) !== undefined && { cacheReadTokens: num(u.cache_read_input_tokens) }),
    ...(num(u.cache_creation_input_tokens) !== undefined && { cacheWriteTokens: num(u.cache_creation_input_tokens) }),
    ...(num(details.thinking_tokens) && { reasoningTokens: num(details.thinking_tokens) })
  }
}

const flattenToolResult = (content: unknown): unknown => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (isRecord(c) && c.type === "text" ? str(c.text) : undefined))
      .filter((t): t is string => t !== undefined)
    if (texts.length === content.length) return texts.join("\n")
  }
  return content
}
