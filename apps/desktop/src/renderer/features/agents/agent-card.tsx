import type { AgentSession, Ticket } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { HarnessIcon, HARNESS_LABELS, SessionStateBadge } from "@/components/status"
import { agentGroup, isSessionUnread } from "@/lib/agent-state"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn, relativeTime } from "@/lib/utils"

export const AgentCard = ({ session, ticket, projectName, list = false }: {
  session: AgentSession; ticket?: Ticket; projectName?: string; list?: boolean
}) => {
  const preview = useQuery(q.sessionPreview(session.id))
  const seen = useUi((s) => s.sessionSeen)
  const markRead = useUi((s) => s.markSessionRead)
  const markUnread = useUi((s) => s.markSessionUnread)
  const unread = isSessionUnread(session, seen)
  return (
    <article className={cn("rounded-md border bg-bg-elevated", agentGroup(session.state) === "attention" && "border-warning/50")} data-testid="agent-session-row">
      <Link to="/issues/$ticketId" params={{ ticketId: session.ticketId }} search={{ tab: "agent", session: session.id }}
        className={cn("block space-y-2 p-3 hover:bg-bg-muted/50", list && "sm:grid sm:grid-cols-[minmax(180px,1fr)_2fr] sm:gap-4 sm:space-y-0")}>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <HarnessIcon harness={session.harness} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{ticket?.title ?? "Agent session"}</span>
            {unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
            <SessionStateBadge state={session.state} />
            <span>{HARNESS_LABELS[session.harness]}</span>
          </div>
        </div>
        <p className="line-clamp-3 text-xs whitespace-pre-wrap text-fg-muted" data-testid="agent-preview">{preview.data || ticket?.description || "No message yet."}</p>
      </Link>
      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[11px] text-fg-subtle">
        <span className="min-w-0 flex-1 truncate">{projectName} {ticket?.identifier && `· ${ticket.identifier}`}</span>
        <time title={session.updatedAt}>{relativeTime(session.updatedAt)}</time>
        <button type="button" className="shrink-0 hover:text-fg" onClick={() => unread ? markRead(session.id, session.lastEventId) : markUnread(session.id)}>
          {unread ? "Mark read" : "Mark unread"}
        </button>
      </div>
    </article>
  )
}
