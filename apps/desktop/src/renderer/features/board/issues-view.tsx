import type { HarnessId, TicketSource } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { Columns3, List, Plus, Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { HARNESS_LABELS } from "@/components/status"
import { agentGroup, ticketSession } from "@/lib/agent-state"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { EmptyState, Spinner } from "@/components/ui/misc"
import type { TicketQuery } from "@/lib/api"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"
import { Board } from "./board"
import { TicketList } from "./ticket-list"

export interface IssuesSearch {
  view?: "board" | "list"
  source?: TicketSource
  q?: string
  project?: string
  harness?: HarnessId
  attention?: boolean
}

export const validateIssuesSearch = (s: Record<string, unknown>): IssuesSearch => ({
  view: s.view === "list" ? "list" : s.view === "board" ? "board" : undefined,
  source: typeof s.source === "string" && /^[a-z0-9_-]+$/.test(s.source) ? s.source : undefined,
  q: typeof s.q === "string" && s.q ? s.q : undefined,
  project: typeof s.project === "string" && s.project ? s.project : undefined,
  harness: typeof s.harness === "string" && Object.hasOwn(HARNESS_LABELS, s.harness) ? s.harness as HarnessId : undefined,
  attention: s.attention === true || s.attention === "true" ? true : undefined
})

/** Board/list of tickets with URL-driven filters (shareable, restorable). */
export const IssuesView = ({
  title,
  search: urlSearch,
  onSearch: navigateSearch,
  fixedProjectId,
  pinnedOnly,
  actions
}: {
  title: React.ReactNode
  search: IssuesSearch
  onSearch: (s: IssuesSearch) => void
  fixedProjectId?: string
  pinnedOnly?: boolean
  actions?: React.ReactNode
}) => {
  const scope = fixedProjectId ? `project:${fixedProjectId}` : pinnedOnly ? "my-issues" : "all-issues"
  const saved = useUi((s) => s.views[scope])
  const setView = useUi((s) => s.setView)
  const initialized = useRef<string | null>(null)
  const first = initialized.current !== scope
  const hasUrlOptions = Object.values(urlSearch).some((v) => v !== undefined)
  const search = first && !hasUrlOptions && saved ? validateIssuesSearch(saved as Record<string, unknown>) : urlSearch
  const onSearch = (value: IssuesSearch) => { setView(scope, value); navigateSearch(value) }
  useEffect(() => {
    if (initialized.current !== scope) {
      initialized.current = scope
      if (!hasUrlOptions && saved) { navigateSearch(validateIssuesSearch(saved as Record<string, unknown>)); return }
    }
    setView(scope, urlSearch)
  }, [scope, urlSearch])
  const projectId = fixedProjectId ?? search.project
  const query: TicketQuery = { projectId, source: search.source, q: search.q, pinned: pinnedOnly }
  const tickets = useQuery(q.tickets(query))
  const sessions = useQuery(q.sessions(false))
  const projects = useQuery(q.projects())
  const shownTickets = (tickets.data ?? []).filter((t) => {
    const session = ticketSession(t, sessions.data ?? [])
    return (!search.harness || (session?.harness ?? t.harness ?? projects.data?.find((p) => p.id === t.projectId)?.defaultHarness) === search.harness) &&
      (!search.attention || t.latestRun?.needsInput || (session && agentGroup(session.state) === "attention"))
  })
  const sources = useQuery(q.sources())
  const projectNames = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data])
  const openCreate = useUi((s) => s.openCreateTicket)
  const [text, setText] = useState(search.q ?? "")
  useEffect(() => setText(search.q ?? ""), [search.q])
  useEffect(() => {
    const id = setTimeout(() => {
      if ((text || undefined) !== search.q) onSearch({ ...search, q: text || undefined })
    }, 250)
    return () => clearTimeout(id)
  }, [text, search.q, search.source, search.project, search.view, search.harness, search.attention, scope])

  const view = search.view ?? "board"
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex min-h-11 flex-wrap items-center gap-2 border-b px-4 py-2">
        <h1 className="text-[13px] font-semibold">{title}</h1>
        <span className="text-xs text-fg-subtle">{tickets.data ? shownTickets.length : ""}</span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter…" className="w-56 pl-7" data-testid="filter" />
        </div>
        <Select aria-label="Filter tickets by source" value={search.source ?? ""} onChange={(e) => onSearch({ ...search, source: (e.target.value || undefined) as TicketSource })}>
          <option value="">All sources</option>
          <option value="local">Local</option>
          {(sources.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </Select>
        {!fixedProjectId && (
          <Select aria-label="Filter tickets by project" value={search.project ?? ""} onChange={(e) => onSearch({ ...search, project: e.target.value || undefined })}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <Select aria-label="Filter tickets by harness" value={search.harness ?? ""} onChange={(e) => onSearch({ ...search, harness: (e.target.value || undefined) as HarnessId | undefined })}>
          <option value="">All harnesses</option>
          {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => <option key={h} value={h}>{HARNESS_LABELS[h]}</option>)}
        </Select>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!search.attention} onChange={(e) => onSearch({ ...search, attention: e.target.checked || undefined })} /> Needs attention</label>
        <Button size="sm" variant="ghost" onClick={() => onSearch({ view: search.view })}>Clear filters</Button>
        <div className="flex rounded-md border p-0.5">
          <button
            className={cn("rounded px-1.5 py-0.5", view === "board" ? "bg-bg-muted text-fg" : "text-fg-subtle")}
            onClick={() => onSearch({ ...search, view: "board" })}
            aria-label="Board view"
            aria-pressed={view === "board"}
          >
            <Columns3 className="size-3.5" />
          </button>
          <button
            className={cn("rounded px-1.5 py-0.5", view === "list" ? "bg-bg-muted text-fg" : "text-fg-subtle")}
            onClick={() => onSearch({ ...search, view: "list" })}
            aria-label="List view"
            aria-pressed={view === "list"}
          >
            <List className="size-3.5" />
          </button>
        </div>
        {actions}
        <Button size="sm" onClick={() => openCreate(projectId)}>
          <Plus /> New
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {tickets.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : projects.data?.length === 0 ? (
          <EmptyState title="No projects yet" action={<a href="#/projects" className="text-accent hover:underline">Register a repository</a>}>
            Projects map tickets to a git repository where agents work in isolated worktrees.
          </EmptyState>
        ) : tickets.error ? (
          <p role="alert" className="p-4 text-xs text-danger">{tickets.error.message}</p>
        ) : view === "board" ? (
          <Board
            tickets={shownTickets}
            sessions={sessions.data ?? []}
            query={query}
            projectNames={fixedProjectId ? undefined : projectNames}
            defaultProjectId={projectId}
          />
        ) : (
          <TicketList tickets={shownTickets} sessions={sessions.data ?? []} projectNames={fixedProjectId ? undefined : projectNames} />
        )}
      </div>
    </div>
  )
}
