import type { AgentSession, Ticket } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { Link, useRouterState } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { HarnessIcon, SessionStateBadge } from "@/components/status"
import { q } from "@/lib/queries"
import { isSessionUnread } from "@/lib/agent-state"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"

const LIVE = new Set(["starting", "running", "waiting_for_approval", "idle"])
const VISIBLE = 5

export interface Thread {
  readonly session: AgentSession
  readonly ticket: Ticket
}

/** Agent sessions grouped by project: live first, then most recently active. */
export const useProjectThreads = () => {
  const sessions = useQuery(q.sessions(false))
  const tickets = useQuery(q.tickets())
  return useMemo(() => {
    const byTicket = new Map((tickets.data ?? []).map((t) => [t.id, t]))
    const byProject = new Map<string, Array<Thread>>()
    for (const session of sessions.data ?? []) {
      const ticket = byTicket.get(session.ticketId)
      // Threads are local tickets and always have a project; skip anything that does not.
      if (!ticket?.projectId) continue
      const list = byProject.get(ticket.projectId) ?? []
      list.push({ session, ticket })
      byProject.set(ticket.projectId, list)
    }
    for (const list of byProject.values()) {
      list.sort(
        (a, b) =>
          Number(LIVE.has(b.session.state)) - Number(LIVE.has(a.session.state)) ||
          b.session.updatedAt.localeCompare(a.session.updatedAt)
      )
    }
    return byProject
  }, [sessions.data, tickets.data])
}

export const ProjectThreads = ({ threads }: { threads: ReadonlyArray<Thread> }) => {
  const [expanded, setExpanded] = useState(false)
  const seen = useUi((s) => s.sessionSeen)
  const location = useRouterState({ select: (s) => s.location })
  const currentSession = (location.search as { session?: string }).session
  // Live threads always show; the rest fold behind "Show more".
  const liveCount = threads.filter((t) => LIVE.has(t.session.state)).length
  const shown = expanded ? threads : threads.slice(0, Math.max(VISIBLE, liveCount))
  if (threads.length === 0) return null
  return (
    <div className="mb-1 flex flex-col gap-px">
      {shown.map(({ session, ticket }) => {
        // Without ?session the Agent tab shows the ticket's active session.
        const active =
          location.pathname === `/issues/${ticket.id}` &&
          (currentSession ? currentSession === session.id : ticket.activeSessionId === session.id && (location.search as { tab?: string }).tab === "agent")
        return (
          <Link
            key={session.id}
            to="/issues/$ticketId"
            params={{ ticketId: ticket.id }}
            search={{ tab: "agent", session: session.id }}
            className={cn(
              "group flex h-7 items-center gap-2 rounded-md pr-1 pl-5 text-[12.5px] text-fg-muted hover:bg-bg-muted hover:text-fg",
              active && "bg-bg-muted text-fg"
            )}
            title={`${ticket.identifier} · ${ticket.title}${session.statusDetail ? `\n${session.statusDetail}` : ""}`}
            data-testid="sidebar-thread"
          >
            <HarnessIcon harness={session.harness} />
            <span className="min-w-0 flex-1 truncate">{ticket.title}</span>
            {isSessionUnread(session, seen) && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
            <ThreadState session={session} />
          </Link>
        )
      })}
      {threads.length > shown.length && (
        <button onClick={() => setExpanded(true)} className="h-6 pl-7 text-left text-[11px] text-fg-subtle hover:text-fg">
          Show {threads.length - shown.length} more
        </button>
      )}
      {expanded && threads.length > VISIBLE && (
        <button onClick={() => setExpanded(false)} className="h-6 pl-7 text-left text-[11px] text-fg-subtle hover:text-fg">
          Show less
        </button>
      )}
    </div>
  )
}

const ThreadState = ({ session }: { session: AgentSession }) => <SessionStateBadge state={session.state} compact />
