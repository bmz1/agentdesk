import type { AgentEvent } from "@agentdesk/contracts"
import { asInlineImage, imageEvents, isRecord, str, type Normalizer } from "@agentdesk/harness-core"

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

  constructor(public sessionId: string) {}

  /** Mark that a prompt was sent so the next idle reports a completed turn. */
  markBusy() {
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
            details: { input: p.metadata, patterns: p.patterns }
          }
        ]
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
            details: { input: p.metadata, resources: p.resources }
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
        return [{ type: "turn.completed", providerSessionId: this.sessionId, status }]
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
