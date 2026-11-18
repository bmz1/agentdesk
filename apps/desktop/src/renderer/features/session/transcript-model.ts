import type { AgentQuestion, ImageRef, PlanItem, QuestionAnswers, StoredAgentEvent, TokenUsage } from "@agentdesk/contracts"

/** Readable permission modes for transcript status lines (the daemon records the mode id). */
const PERMISSION_LABELS: Record<string, string> = {
  ask: "ask for risky tools",
  accept_edits: "auto-accept file edits",
  auto: "auto (agent reviews approvals)",
  plan: "plan only",
  unrestricted: "unrestricted"
}

export type TranscriptItem =
  | { kind: "user"; key: string; text: string; images: ReadonlyArray<ImageRef>; at: string }
  | { kind: "image"; key: string; image: ImageRef; toolCallId?: string }
  | { kind: "assistant"; key: string; messageId?: string; text: string; streaming: boolean; at: string }
  | { kind: "reasoning"; key: string; text: string }
  | {
      kind: "tool"
      key: string
      toolCallId: string
      name: string
      input: unknown
      result?: unknown
      isError?: boolean
      done: boolean
    }
  | {
      kind: "approval"
      key: string
      approvalId: string
      toolName: string
      summary: string
      details: unknown
      decision?: "allow" | "deny"
      /** "question": answered with `questions`' ids instead of allowed. */
      question?: ReadonlyArray<AgentQuestion>
      canAllowForSession?: boolean
      scope?: "once" | "session"
      answers?: QuestionAnswers
    }
  | { kind: "status"; key: string; text: string; tone: "neutral" | "warning" | "danger" | "success" }
  | { kind: "turn"; key: string; status: string; costUsd?: number; durationMs?: number; usage?: TokenUsage }

/**
 * Incrementally folds canonical agent events into renderable transcript items.
 * Deltas are merged into the current streaming assistant message; a completed
 * message replaces the streamed text for the same message id.
 */
export class TranscriptBuilder {
  items: Array<TranscriptItem> = []
  /** The agent's latest plan or to-do list, if it keeps one. */
  plan: ReadonlyArray<PlanItem> | undefined
  private seen = new Set<number>()
  private tools = new Map<string, number>()
  private approvals = new Map<string, number>()
  lastId = 0
  version = 0

  apply(events: ReadonlyArray<StoredAgentEvent>) {
    let changed = false
    for (const s of events) {
      if (this.seen.has(s.id)) continue
      this.seen.add(s.id)
      this.lastId = Math.max(this.lastId, s.id)
      this.applyOne(s)
      changed = true
    }
    if (changed) {
      this.items = [...this.items]
      this.version++
    }
    return changed
  }

  private replace(i: number, item: TranscriptItem) {
    this.items[i] = item
  }

  private applyOne(s: StoredAgentEvent) {
    const e = s.event
    const key = String(s.id)
    switch (e.type) {
      case "user.prompt":
        this.finalizeStreaming()
        this.items.push({ kind: "user", key, text: e.text, images: e.images ?? [], at: s.at })
        break
      case "message.delta": {
        const last = this.items.at(-1)
        if (last?.kind === "assistant" && last.streaming && (last.messageId === e.messageId || !e.messageId)) {
          this.replace(this.items.length - 1, { ...last, text: last.text + e.text })
        } else {
          this.items.push({ kind: "assistant", key, messageId: e.messageId, text: e.text, streaming: true, at: s.at })
        }
        break
      }
      case "message.completed": {
        const last = this.items.at(-1)
        if (last?.kind === "assistant" && last.streaming && (!e.messageId || last.messageId === e.messageId)) {
          this.replace(this.items.length - 1, { ...last, text: e.text, streaming: false })
        } else {
          this.items.push({ kind: "assistant", key, messageId: e.messageId, text: e.text, streaming: false, at: s.at })
        }
        break
      }
      case "reasoning":
        this.items.push({ kind: "reasoning", key, text: e.text })
        break
      case "image":
        // Only stored references reach the UI; the daemon resolves inline sources first.
        if (e.image) this.items.push({ kind: "image", key, image: e.image, toolCallId: e.toolCallId })
        break
      case "tool.started":
        this.finalizeStreaming()
        this.tools.set(e.toolCallId, this.items.length)
        this.items.push({ kind: "tool", key, toolCallId: e.toolCallId, name: e.name, input: e.input, done: false })
        break
      case "tool.completed": {
        const i = this.tools.get(e.toolCallId)
        const item = i !== undefined ? this.items[i] : undefined
        if (i !== undefined && item?.kind === "tool") {
          this.replace(i, { ...item, result: e.result, isError: e.isError, done: true })
        } else {
          this.items.push({ kind: "tool", key, toolCallId: e.toolCallId, name: "tool", input: undefined, result: e.result, isError: e.isError, done: true })
        }
        break
      }
      case "approval.requested":
        this.approvals.set(e.approvalId, this.items.length)
        this.items.push({
          kind: "approval",
          key,
          approvalId: e.approvalId,
          toolName: e.toolName,
          summary: e.summary,
          details: e.details,
          ...(e.kind === "question" && { question: e.questions ?? [] }),
          ...(e.canAllowForSession && { canAllowForSession: true })
        })
        break
      case "approval.resolved": {
        const i = this.approvals.get(e.approvalId)
        const item = i !== undefined ? this.items[i] : undefined
        if (i !== undefined && item?.kind === "approval") {
          this.replace(i, { ...item, decision: e.decision, ...(e.scope && { scope: e.scope }), ...(e.answers && { answers: e.answers }) })
        }
        break
      }
      case "turn.completed":
        this.finalizeStreaming()
        this.items.push({ kind: "turn", key, status: e.status ?? "success", costUsd: e.costUsd, durationMs: e.durationMs, usage: e.usage })
        break
      case "plan.updated":
        this.plan = e.items
        break
      case "session.started":
        this.items.push({ kind: "status", key, text: `Session started${e.model ? ` · ${e.model}` : ""}`, tone: "neutral" })
        break
      case "session.status":
        // Daemon restarts are not errors: a conversation picks up again with the next follow-up.
        if (e.state === "interrupted" && e.detail === "Daemon shutting down") break
        if (e.state === "restarted" || (e.state === "interrupted" && e.detail?.startsWith("The daemon restarted."))) {
          this.items.push({ kind: "status", key, text: e.state === "restarted" ? e.detail ?? "AgentDesk restarted" : "AgentDesk restarted. Send a follow-up to continue.", tone: "neutral" })
          break
        }
        if (e.state === "permissions") {
          this.items.push({ kind: "status", key, text: `Permissions · ${(e.detail && PERMISSION_LABELS[e.detail]) ?? e.detail ?? "unknown"}`, tone: "neutral" })
          break
        }
        this.items.push({
          kind: "status",
          key,
          text:
            e.state === "edit_blocked" || e.state === "worktree_adopted"
              ? e.detail ?? e.state.replace(/_/g, " ")
              : e.detail ? `${e.state.replace(/_/g, " ")} — ${e.detail}` : e.state.replace(/_/g, " "),
          tone: e.state === "interrupted" || e.state === "edit_blocked" ? "warning" : e.state === "worktree_adopted" ? "success" : "neutral"
        })
        break
      case "session.error":
        this.items.push({ kind: "status", key, text: e.message, tone: "danger" })
        break
      case "session.exited":
        this.finalizeStreaming()
        this.items.push({
          kind: "status",
          key,
          text: `Agent process exited${e.code !== undefined && e.code !== null ? ` (code ${e.code})` : ""}`,
          tone: e.code ? "danger" : "neutral"
        })
        break
    }
  }

  private finalizeStreaming() {
    const last = this.items.at(-1)
    if (last?.kind === "assistant" && last.streaming) this.replace(this.items.length - 1, { ...last, streaming: false })
  }
}
