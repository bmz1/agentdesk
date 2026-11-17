import { createFileRoute } from "@tanstack/react-router"
import { type TicketTab, TicketDetail } from "@/features/ticket/ticket-detail"
import { q } from "@/lib/queries"

const TABS: ReadonlyArray<TicketTab> = ["overview", "agent", "workflow", "changes", "files", "checks", "history"]

export const Route = createFileRoute("/issues/$ticketId")({
  validateSearch: (s: Record<string, unknown>): { tab?: TicketTab; session?: string } => ({
    tab: TABS.includes(s.tab as TicketTab) ? (s.tab as TicketTab) : undefined,
    session: typeof s.session === "string" ? s.session : undefined
  }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.ticket(params.ticketId)),
  component: TicketRoute
})

function TicketRoute() {
  const { ticketId } = Route.useParams()
  const { tab, session } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <TicketDetail
      ticketId={ticketId}
      tab={tab ?? "overview"}
      sessionId={session}
      onTab={(t) => navigate({ search: (s) => ({ ...s, tab: t }), replace: true })}
      onSession={(id) => navigate({ search: (s) => ({ ...s, tab: "agent", session: id }), replace: true })}
    />
  )
}
