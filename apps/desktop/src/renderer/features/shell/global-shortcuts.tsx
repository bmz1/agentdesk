import { useQueryClient } from "@tanstack/react-query"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import type { AgentSession } from "@agentdesk/contracts"
import { nextAttention } from "@/lib/agent-state"
import { useShortcut } from "@/lib/keymap"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"

/** Open the next session that needs you (⌘J). Returns false when nothing does. */
export const useJumpToAttention = () => {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const currentSession = useRouterState({ select: (s) => (s.location.search as { session?: string }).session })
  return async () => {
    const sessions: ReadonlyArray<AgentSession> = await qc.ensureQueryData(q.sessions(false))
    const next = nextAttention(sessions, useUi.getState().sessionSeen, currentSession)
    if (!next) return false
    void navigate({ to: "/issues/$ticketId", params: { ticketId: next.ticketId }, search: { tab: "agent", session: next.id } })
    return true
  }
}

/** App-wide shortcuts; context-specific ones (approve, interrupt) live with their views. */
export const GlobalShortcuts = () => {
  const navigate = useNavigate()
  const jump = useJumpToAttention()

  useShortcut("palette", () => useUi.getState().setCommandOpen(!useUi.getState().commandOpen))
  useShortcut("newThread", () => useUi.getState().openCreateTicket(undefined, "thread"))
  useShortcut("newTicket", () => useUi.getState().openCreateTicket())
  useShortcut("toggleSidebar", () => useUi.getState().toggleSidebar())
  useShortcut("goInbox", () => void navigate({ to: "/inbox" }))
  useShortcut("goIssues", () => void navigate({ to: "/issues" }))
  useShortcut("goAgents", () => void navigate({ to: "/agents" }))
  useShortcut("goWorkflows", () => void navigate({ to: "/workflows" }))
  useShortcut("goProjects", () => void navigate({ to: "/projects" }))
  useShortcut("goSettings", () => void navigate({ to: "/settings" }))
  useShortcut("nextAttention", () => void jump())
  return null
}
