import type { AgentSession, Ticket } from "@agentdesk/contracts"
import { Link } from "@tanstack/react-router"
import { BOARD_COLUMNS, NeedsInputDot, PriorityIcon, RunStatusBadge, SessionStateBadge, SourceBadge, StatusIcon } from "@/components/status"
import { EmptyState } from "@/components/ui/misc"
import { ticketSession } from "@/lib/agent-state"
import { relativeTime } from "@/lib/utils"
import { groupByStatus } from "./board"

export const TicketList = ({ tickets, projectNames, sessions = [] }: { tickets: ReadonlyArray<Ticket>; projectNames?: Map<string, string>; sessions?: ReadonlyArray<AgentSession> }) => {
  const groups = groupByStatus(tickets)
  if (tickets.length === 0) return <EmptyState title="No tickets match" />
  return (
    <div className="overflow-y-auto">
      {BOARD_COLUMNS.map((col) => {
        const list = groups.get(col.id) ?? []
        if (list.length === 0) return null
        return (
          <div key={col.id}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-bg-subtle px-4 py-1.5 text-xs font-medium">
              <StatusIcon status={col.id} /> {col.label} <span className="text-fg-subtle">{list.length}</span>
            </div>
            {list.map((t) => {
              const session = ticketSession(t, sessions)
              return (
              <Link
                key={t.id}
                to="/issues/$ticketId"
                params={{ ticketId: t.id }}
                className="flex h-9 items-center gap-3 border-b px-4 text-[13px] hover:bg-bg-subtle"
              >
                <PriorityIcon priority={t.priority} />
                <span className="w-20 shrink-0 font-mono text-[11px] text-fg-subtle">{t.identifier}</span>
                <StatusIcon status={t.status} />
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                {(t.latestRun?.needsInput || session?.state === "waiting_for_approval") && <NeedsInputDot />}
                {session && <SessionStateBadge state={session.state} />}
                {t.latestRun && <RunStatusBadge status={t.latestRun.status} />}
                <SourceBadge ticket={t} />
                {projectNames && <span className="w-28 truncate text-xs text-fg-subtle">{projectNames.get(t.projectId)}</span>}
                <span className="w-16 text-right text-[11px] text-fg-subtle">{relativeTime(t.lastActivityAt)}</span>
              </Link>
            )})}
          </div>
        )
      })}
    </div>
  )
}
