import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Bot } from "lucide-react"
import { useMemo } from "react"
import { HARNESS_LABELS, SessionStateBadge } from "@/components/status"
import { EmptyState } from "@/components/ui/misc"
import { q } from "@/lib/queries"
import { relativeTime } from "@/lib/utils"

export const Route = createFileRoute("/agents/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.sessions(false)),
  component: Agents
})

function Agents() {
  const sessions = useQuery({ ...q.sessions(false), refetchInterval: 10_000 })
  const tickets = useQuery(q.tickets())
  const byId = useMemo(() => new Map((tickets.data ?? []).map((t) => [t.id, t])), [tickets.data])
  const all = sessions.data ?? []
  const live = all.filter((s) => ["starting", "running", "waiting_for_approval", "idle"].includes(s.state))
  const recent = all.filter((s) => !live.includes(s)).slice(0, 50)

  const Row = ({ s }: { s: (typeof all)[number] }) => {
    const t = byId.get(s.ticketId)
    return (
      <Link
        to="/issues/$ticketId"
        params={{ ticketId: s.ticketId }}
        search={{ tab: "agent", session: s.id }}
        className="flex h-10 items-center gap-3 border-b px-4 text-[13px] hover:bg-bg-subtle"
        data-testid="agent-session-row"
      >
        <Bot className="size-3.5 text-fg-muted" />
        <span className="w-28 text-xs text-fg-muted">{HARNESS_LABELS[s.harness]}</span>
        <span className="w-20 shrink-0 font-mono text-[11px] text-fg-subtle">{t?.identifier}</span>
        <span className="min-w-0 flex-1 truncate">{t?.title ?? s.ticketId}</span>
        {s.runId && <span className="text-[11px] text-fg-subtle">workflow</span>}
        <SessionStateBadge state={s.state} />
        <span className="w-20 text-right text-[11px] text-fg-subtle">{relativeTime(s.updatedAt)}</span>
      </Link>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">My agents' work</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 border-b bg-bg-subtle px-4 py-1.5 text-xs font-medium">Active · {live.length}</div>
        {live.length === 0 ? <EmptyState icon={<Bot />} title="No agents running" /> : live.map((s) => <Row key={s.id} s={s} />)}
        <div className="sticky top-0 border-b bg-bg-subtle px-4 py-1.5 text-xs font-medium">Recent</div>
        {recent.map((s) => (
          <Row key={s.id} s={s} />
        ))}
      </div>
    </div>
  )
}
