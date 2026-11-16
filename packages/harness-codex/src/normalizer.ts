import type { AgentEvent } from "@agentdesk/contracts"
import { isRecord, num, str, type Normalizer } from "@agentdesk/harness-core"

/** Server→client JSON-RPC requests that ask the user for approval. */
export const APPROVAL_METHODS: Record<string, { tool: string; legacy: boolean }> = {
  "item/commandExecution/requestApproval": { tool: "Bash", legacy: false },
  "item/fileChange/requestApproval": { tool: "Edit", legacy: false },
  execCommandApproval: { tool: "Bash", legacy: true },
  applyPatchApproval: { tool: "Edit", legacy: true }
}

/**
 * Normalizes `codex app-server` JSON-RPC notifications and approval requests
 * into canonical events. Tracks the active thread/turn for interrupts.
 */
export class CodexNormalizer implements Normalizer {
  threadId: string | undefined
  activeTurnId: string | undefined
  private fileChanges = new Map<string, string>()

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
        return []
      }
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
        out.push({
          type: "turn.completed",
          providerSessionId: this.threadId,
          status: status === "interrupted" ? "interrupted" : status === "failed" ? "error" : "success",
          durationMs: num(turn.durationMs)
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

  private serverRequest(method: string, id: string, params: Record<string, unknown>): ReadonlyArray<AgentEvent> {
    const spec = APPROVAL_METHODS[method]
    if (!spec) return []
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
        details: { input: command ? { command, cwd: params.cwd } : params, reason: params.reason }
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
      case "mcpToolCall":
        return [{ type: "tool.completed", toolCallId: id, result: item.error ?? item.result, isError: !!item.error }]
      case "webSearch":
        return [{ type: "tool.completed", toolCallId: id, result: item.query }]
      default:
        return []
    }
  }
}
