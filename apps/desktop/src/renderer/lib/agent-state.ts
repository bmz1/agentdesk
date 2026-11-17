import type { AgentSession, Approval, Ticket } from "@agentdesk/contracts"

export type AgentGroup = "attention" | "working" | "followup" | "recent"
export const AGENT_GROUPS: ReadonlyArray<{ id: AgentGroup; label: string }> = [
  { id: "attention", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "followup", label: "Awaiting follow-up" },
  { id: "recent", label: "Recent" }
]
export const agentGroup = (state: AgentSession["state"]): AgentGroup => {
  if (state === "waiting_for_approval" || state === "failed" || state === "interrupted") return "attention"
  if (state === "starting" || state === "running") return "working"
  if (state === "idle") return "followup"
  return "recent"
}
export const SESSION_LABELS: Record<AgentSession["state"], string> = {
  starting: "Starting", running: "Running", waiting_for_approval: "Needs approval",
  idle: "Awaiting follow-up", completed: "Turn finished", failed: "Failed", interrupted: "Interrupted", closed: "Stopped"
}
/** Key in the read map holding the epoch ms before which sessions never seen count as read. */
export const READ_BASELINE_KEY = "*"

export const isSessionUnread = (session: AgentSession, seen: Record<string, number>) => {
  const mark = seen[session.id]
  if (mark === -1) return true
  if (agentGroup(session.state) === "working") return false
  const baseline = seen[READ_BASELINE_KEY]
  if (mark === undefined && baseline !== undefined && Date.parse(session.updatedAt) <= baseline) return false
  return session.lastEventId > (mark ?? 0)
}

/** Prefer the active session; a historical failure must not mask a newer attempt. */
export const ticketSession = (ticket: Ticket, sessions: ReadonlyArray<AgentSession>) =>
  sessions.find((s) => s.id === ticket.activeSessionId) ??
  sessions.filter((s) => s.ticketId === ticket.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]

/** An unread session awaiting approval is one Inbox item, not two badge entries. */
export const notificationCount = (
  sessions: ReadonlyArray<AgentSession>,
  approvals: ReadonlyArray<Pick<Approval, "sessionId">>,
  seen: Record<string, number>
) => {
  const approvalSessions = new Set(approvals.map((a) => a.sessionId).filter(Boolean))
  return approvals.length + sessions.filter((s) => isSessionUnread(s, seen) && !approvalSessions.has(s.id)).length
}

/**
 * Where ⌘J goes: sessions blocked on an approval first, then unread ones (newest first).
 * Cycles past `currentId`, so repeated presses walk the whole queue.
 */
export const nextAttention = (
  sessions: ReadonlyArray<AgentSession>,
  seen: Record<string, number>,
  currentId?: string
): AgentSession | undefined => {
  const queue = sessions
    .filter((s) => s.state === "waiting_for_approval" || isSessionUnread(s, seen))
    .sort(
      (a, b) =>
        Number(b.state === "waiting_for_approval") - Number(a.state === "waiting_for_approval") ||
        b.updatedAt.localeCompare(a.updatedAt)
    )
  if (queue.length === 0) return undefined
  const i = queue.findIndex((s) => s.id === currentId)
  return queue[(i + 1) % queue.length]
}
