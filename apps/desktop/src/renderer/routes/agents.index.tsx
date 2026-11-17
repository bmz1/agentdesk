import type { HarnessId } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Columns3, List } from "lucide-react"
import { useMemo } from "react"
import { HARNESS_LABELS } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { EmptyState, Spinner } from "@/components/ui/misc"
import { AgentCard } from "@/features/agents/agent-card"
import { AGENT_GROUPS, agentGroup, isSessionUnread } from "@/lib/agent-state"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"

export const Route = createFileRoute("/agents/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.sessions(false)),
  component: Agents
})

function Agents() {
  const sessions = useQuery({ ...q.sessions(false), refetchInterval: 10_000 })
  const tickets = useQuery(q.tickets())
  const projects = useQuery(q.projects())
  const preferences = useUi((s) => s.views.agents)
  const setView = useUi((s) => s.setView)
  const seen = useUi((s) => s.sessionSeen)
  const options = preferences ?? {}
  const update = (value: Partial<typeof options>) => setView("agents", { ...options, ...value })
  const byId = useMemo(() => new Map((tickets.data ?? []).map((t) => [t.id, t])), [tickets.data])
  const projectNames = new Map((projects.data ?? []).map((p) => [p.id, p.name]))
  const filtered = (sessions.data ?? []).filter((s) => {
    const ticket = byId.get(s.ticketId)
    return (!options.project || ticket?.projectId === options.project) && (!options.harness || s.harness === options.harness) &&
      (!options.attention || isSessionUnread(s, seen) || agentGroup(s.state) === "attention") &&
      (!options.q || `${ticket?.title} ${ticket?.identifier} ${projectNames.get(ticket?.projectId ?? "")} ${HARNESS_LABELS[s.harness]}`.toLowerCase().includes(options.q.toLowerCase()))
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const board = options.view !== "list"
  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-11 flex-wrap items-center gap-2 border-b px-4 py-2">
        <h1 className="mr-auto text-[13px] font-semibold">Agents <span className="text-fg-subtle">{filtered.length}</span></h1>
        <Input aria-label="Search agents" placeholder="Search agents…" value={options.q ?? ""} onChange={(e) => update({ q: e.target.value })} className="w-44" />
        <Select aria-label="Filter agents by project" value={options.project ?? ""} onChange={(e) => update({ project: e.target.value })}>
          <option value="">All projects</option>
          {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select aria-label="Filter agents by harness" value={options.harness ?? ""} onChange={(e) => update({ harness: e.target.value })}>
          <option value="">All harnesses</option>
          {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => <option key={h} value={h}>{HARNESS_LABELS[h]}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!options.attention} onChange={(e) => update({ attention: e.target.checked })} /> Attention / unread</label>
        <Button size="sm" variant="ghost" onClick={() => setView("agents", { view: options.view })}>Clear filters</Button>
        <Button size="icon" variant={board ? "secondary" : "ghost"} aria-label="Agents board view" aria-pressed={board} onClick={() => update({ view: "board" })}><Columns3 /></Button>
        <Button size="icon" variant={!board ? "secondary" : "ghost"} aria-label="Agents list view" aria-pressed={!board} onClick={() => update({ view: "list" })}><List /></Button>
      </header>
      {sessions.error && <p role="alert" className="p-4 text-xs text-danger">{sessions.error.message}</p>}
      {sessions.isPending ? <Spinner /> : filtered.length === 0 ? <EmptyState title="No matching agents" /> : (
        <div className={board ? "flex min-h-0 flex-1 gap-3 overflow-x-auto p-3" : "min-h-0 flex-1 space-y-4 overflow-y-auto p-3"} data-testid="agents-view">
          {AGENT_GROUPS.map((group) => {
            const items = filtered.filter((s) => agentGroup(s.state) === group.id)
            return (
              <section key={group.id} className={board ? "flex min-w-64 flex-1 flex-col" : ""} data-testid={`agents-${group.id}`}>
                <h2 className="mb-2 text-xs font-medium">{group.label} · {items.length}</h2>
                <div className={board ? "min-h-0 space-y-2 overflow-y-auto" : "space-y-2"}>
                  {items.map((s) => <AgentCard key={s.id} session={s} ticket={byId.get(s.ticketId)} projectName={projectNames.get(byId.get(s.ticketId)?.projectId ?? "")} list={!board} />)}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
