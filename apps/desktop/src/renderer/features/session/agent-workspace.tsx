import type { Ticket } from "@agentdesk/contracts"
import { useRef } from "react"
import { ReviewChanges } from "@/features/diff/review-changes"
import { useUi } from "@/lib/store"
import { AgentPanel } from "./agent-panel"

export const AgentWorkspace = ({
  ticket,
  sessionId,
  onSelectSession
}: {
  ticket: Ticket
  sessionId?: string
  onSelectSession: (id: string | undefined) => void
}) => {
  const layout = useUi((s) => s.ticketLayouts[ticket.id])
  const setLayout = useUi((s) => s.setTicketLayout)
  const container = useRef<HTMLDivElement>(null)
  const width = layout?.width ?? 50
  const resize = (value: number) => setLayout(ticket.id, { split: true, width: Math.max(25, Math.min(75, value)) })
  return (
    <div ref={container} className="flex h-full min-h-0 min-w-0" data-testid="agent-workspace">
      <section className="min-h-0 min-w-0 overflow-hidden" style={{ width: `${width}%` }} aria-label="Agent conversation">
        <AgentPanel ticket={ticket} sessionId={sessionId} onSelectSession={onSelectSession} />
      </section>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize conversation and changes"
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(width)}
        className="w-1.5 shrink-0 touch-none cursor-col-resize border-x bg-bg-subtle hover:bg-accent/30 focus:bg-accent/30 focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault()
            resize(width + (e.key === "ArrowLeft" ? -5 : 5))
          }
        }}
        onPointerDown={(e) => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
          const bounds = container.current?.getBoundingClientRect()
          if (bounds) resize(((e.clientX - bounds.left) / bounds.width) * 100)
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        }}
      />
      <section className="min-h-0 min-w-0 flex-1 overflow-auto" aria-label="Changes and review">
        <ReviewChanges ticket={ticket} onSelectSession={onSelectSession} />
      </section>
    </div>
  )
}
