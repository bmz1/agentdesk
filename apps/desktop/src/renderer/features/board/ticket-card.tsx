import type { Ticket } from "@agentdesk/contracts"
import { Link } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import { HARNESS_LABELS, NeedsInputDot, PriorityIcon, RunStatusBadge, SourceBadge } from "@/components/status"
import { cn, relativeTime } from "@/lib/utils"

export const TicketCard = ({ ticket, dragging, projectName }: { ticket: Ticket; dragging?: boolean; projectName?: string }) => {
  const needsInput = ticket.latestRun?.needsInput
  return (
    <Link
      to="/issues/$ticketId"
      params={{ ticketId: ticket.id }}
      className={cn(
        "block rounded-md border bg-bg-elevated px-2.5 py-2 shadow-sm transition-colors hover:border-border-strong",
        dragging && "rotate-1 shadow-xl ring-1 ring-accent/40",
        needsInput && "border-warning/50"
      )}
      data-testid="ticket-card"
      draggable={false}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
        <span className="font-mono">{ticket.identifier}</span>
        {projectName && <span className="truncate">· {projectName}</span>}
        <div className="flex-1" />
        {needsInput && <NeedsInputDot />}
        <PriorityIcon priority={ticket.priority} />
      </div>
      <div className="mt-1 line-clamp-2 text-[13px] leading-snug">{ticket.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <SourceBadge ticket={ticket} />
        {ticket.latestRun && <RunStatusBadge status={ticket.latestRun.status} />}
        {ticket.activeSessionId && !ticket.latestRun && (
          <span className="inline-flex items-center gap-1 rounded bg-accent/15 px-1.5 py-px text-[11px] text-accent">
            <Bot className="size-3" /> agent
          </span>
        )}
        {ticket.harness && <span className="text-[11px] text-fg-subtle">{HARNESS_LABELS[ticket.harness]}</span>}
        {ticket.labels.slice(0, 2).map((l) => (
          <span key={l} className="rounded border px-1 text-[10px] text-fg-subtle">
            {l}
          </span>
        ))}
        <span className="ml-auto text-[11px] text-fg-subtle" title={ticket.lastActivityAt}>
          {relativeTime(ticket.lastActivityAt)}
        </span>
      </div>
    </Link>
  )
}
