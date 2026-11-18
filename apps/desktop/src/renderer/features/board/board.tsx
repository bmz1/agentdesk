import type { AgentSession, BoardStatus, Ticket } from "@agentdesk/contracts"
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors
} from "@dnd-kit/core"
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"
import { BOARD_COLUMNS, StatusIcon } from "@/components/status"
import { Button } from "@/components/ui/button"
import { api, type TicketQuery } from "@/lib/api"
import { ticketSession } from "@/lib/agent-state"
import { qk } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"
import { TicketCard } from "./ticket-card"
import { toast } from "sonner"

/** Compute a sort key between neighbours (fractional ordering avoids renumbering). */
export const sortKeyBetween = (prev: number | undefined, next: number | undefined) => {
  if (prev === undefined && next === undefined) return 0
  if (prev === undefined) return next! - 1
  if (next === undefined) return prev + 1
  return (prev + next) / 2
}

/** Project shown on a card when the view spans projects; imported tickets may have none yet. */
export const projectLabel = (names: ReadonlyMap<string, string> | undefined, projectId: string | null) =>
  names ? (projectId ? names.get(projectId) : "Unassigned") : undefined

export const groupByStatus = (tickets: ReadonlyArray<Ticket>) => {
  const groups = new Map<BoardStatus, Array<Ticket>>(BOARD_COLUMNS.map((c) => [c.id, []]))
  for (const t of tickets) groups.get(t.status)?.push(t)
  for (const list of groups.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || b.updatedAt.localeCompare(a.updatedAt))
  return groups
}

export const Board = ({
  tickets,
  query,
  projectNames,
  defaultProjectId,
  sessions = []
}: {
  tickets: ReadonlyArray<Ticket>
  sessions?: ReadonlyArray<AgentSession>
  query: TicketQuery
  projectNames?: Map<string, string>
  defaultProjectId?: string
}) => {
  const qc = useQueryClient()
  const groups = useMemo(() => groupByStatus(tickets), [tickets])
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = activeId ? tickets.find((t) => t.id === activeId) : undefined
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const move = useMutation({
    mutationFn: ({ id, status, sortOrder }: { id: string; status: BoardStatus; sortOrder: number }) =>
      api.updateTicket(id, { status, sortOrder }),
    onMutate: async ({ id, status, sortOrder }) => {
      const key = qk.tickets(query)
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<ReadonlyArray<Ticket>>(key)
      qc.setQueryData<ReadonlyArray<Ticket>>(key, (old) => old?.map((t) => (t.id === id ? { ...t, status, sortOrder } : t)))
      return { prev, key }
    },
    onError: (e, _v, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.prev)
      toast.error("Couldn't move ticket", { description: e.message })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["tickets"] })
  })

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setActiveId(null)
    const id = String(e.active.id)
    const overId = e.over?.id ? String(e.over.id) : undefined
    if (!overId || overId === id) return
    const ticket = tickets.find((t) => t.id === id)
    if (!ticket) return
    const overTicket = tickets.find((t) => t.id === overId)
    const status = (overTicket?.status ?? overId.replace(/^col:/, "")) as BoardStatus
    const column = (groups.get(status) ?? []).filter((t) => t.id !== id)
    let index = overTicket ? column.findIndex((t) => t.id === overTicket.id) : column.length
    // Dragging downward within the same column lands after the hovered card.
    if (overTicket && ticket.status === status) {
      const original = groups.get(status) ?? []
      if (original.findIndex((t) => t.id === id) < original.findIndex((t) => t.id === overTicket.id)) index += 1
    }
    const sortOrder = sortKeyBetween(column[index - 1]?.sortOrder, column[index]?.sortOrder)
    if (status === ticket.status && sortOrder === ticket.sortOrder) return
    move.mutate({ id, status, sortOrder })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ticket ${labelOf(tickets, active.id)}`,
          onDragOver: ({ over }) => (over ? `Over ${describeOver(tickets, over.id)}` : "Not over a column"),
          onDragEnd: ({ over }) => (over ? `Dropped in ${describeOver(tickets, over.id)}` : "Dropped"),
          onDragCancel: () => "Move cancelled"
        }
      }}
    >
      <div className="flex h-full gap-3 overflow-x-auto p-3" data-testid="board">
        {BOARD_COLUMNS.map((col) => (
          <Column
            key={col.id}
            id={col.id}
            label={col.label}
            tickets={groups.get(col.id) ?? []}
            projectNames={projectNames}
            defaultProjectId={defaultProjectId}
            sessions={sessions}
          />
        ))}
      </div>
      <DragOverlay>
        {active ? (
          <TicketCard
            ticket={active}
            session={ticketSession(active, sessions)}
            dragging
            projectName={projectLabel(projectNames, active.projectId)}
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

const labelOf = (tickets: ReadonlyArray<Ticket>, id: string | number) => tickets.find((t) => t.id === id)?.identifier ?? ""
const describeOver = (tickets: ReadonlyArray<Ticket>, id: string | number) => {
  const s = String(id)
  if (s.startsWith("col:")) return BOARD_COLUMNS.find((c) => `col:${c.id}` === s)?.label ?? s
  const t = tickets.find((x) => x.id === s)
  return t ? `${t.identifier} in ${BOARD_COLUMNS.find((c) => c.id === t.status)?.label}` : s
}

const Column = ({
  id,
  label,
  tickets,
  projectNames,
  defaultProjectId,
  sessions
}: {
  sessions: ReadonlyArray<AgentSession>
  id: BoardStatus
  label: string
  tickets: Array<Ticket>
  projectNames?: Map<string, string>
  defaultProjectId?: string
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}` })
  const openCreate = useUi((s) => s.openCreateTicket)
  return (
    <div className="flex min-w-60 flex-1 flex-col" data-testid={`column-${id}`}>
      <div className="flex h-8 items-center gap-2 px-1.5 pb-1">
        <StatusIcon status={id} />
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-xs text-fg-subtle">{tickets.length}</span>
        <div className="flex-1" />
        {id === "todo" && (
          <Button variant="ghost" size="icon" className="size-6" onClick={() => openCreate(defaultProjectId)} aria-label="Create ticket">
            <Plus />
          </Button>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={cn("flex min-h-24 flex-1 flex-col gap-1.5 overflow-y-auto rounded-lg p-1 transition-colors", isOver && "bg-bg-muted/60")}
      >
        <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tickets.map((t) => (
            <SortableCard
              key={t.id}
              ticket={t}
              session={ticketSession(t, sessions)}
              projectName={projectLabel(projectNames, t.projectId)}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  )
}

const SortableCard = ({ ticket, projectName, session }: { ticket: Ticket; projectName?: string; session?: AgentSession }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: ticket.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && "opacity-30")}
      {...attributes}
      {...listeners}
    >
      <TicketCard ticket={ticket} session={session} projectName={projectName} />
    </div>
  )
}
