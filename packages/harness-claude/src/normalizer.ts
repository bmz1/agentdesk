import type { AgentEvent } from "@agentdesk/contracts"
import { extractImages, imageEvents, isRecord, num, str, summarizeToolInput, type Normalizer } from "@agentdesk/harness-core"

/**
 * Normalizes Claude Code `--output-format stream-json --verbose --include-partial-messages`
 * output into canonical events.
 */
export class ClaudeNormalizer implements Normalizer {
  providerSessionId: string | undefined

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
        out.push({
          type: "tool.started",
          toolCallId: str(block.id) ?? "unknown",
          name: str(block.name) ?? "tool",
          input: block.input
        })
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
      out.push({
        type: "tool.completed",
        toolCallId,
        result: flattenToolResult(rest),
        isError: block.is_error === true
      })
      out.push(...imageEvents(images, toolCallId))
    }
    return out
  }

  private controlRequest(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const req = msg.request
    const requestId = str(msg.request_id)
    if (!isRecord(req) || !requestId || req.subtype !== "can_use_tool") return []
    const toolName = str(req.tool_name) ?? "tool"
    return [
      {
        type: "approval.requested",
        approvalId: requestId,
        providerRequestId: requestId,
        toolName,
        summary: str(req.description)
          ? `${toolName}: ${str(req.description)}`
          : summarizeToolInput(toolName, req.input),
        details: { input: req.input, toolUseId: req.tool_use_id, blockedPath: req.blocked_path }
      }
    ]
  }

  private result(msg: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const isError = msg.is_error === true || (str(msg.subtype) ?? "").startsWith("error")
    return [
      {
        type: "turn.completed",
        providerSessionId: str(msg.session_id),
        status: isError ? "error" : "success",
        costUsd: num(msg.total_cost_usd),
        durationMs: num(msg.duration_ms),
        summary: str(msg.result)
      }
    ]
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
