import type { TicketSource } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { Columns3, List, Plus, Search } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
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
}

export const validateIssuesSearch = (s: Record<string, unknown>): IssuesSearch => ({
  view: s.view === "list" ? "list" : s.view === "board" ? "board" : undefined,
  source: s.source === "jira" || s.source === "local" ? s.source : undefined,
  q: typeof s.q === "string" && s.q ? s.q : undefined,
  project: typeof s.project === "string" && s.project ? s.project : undefined
})

/** Board/list of tickets with URL-driven filters (shareable, restorable). */
export const IssuesView = ({
  title,
  search,
  onSearch,
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
  const projectId = fixedProjectId ?? search.project
  const query: TicketQuery = { projectId, source: search.source, q: search.q, pinned: pinnedOnly }
  const tickets = useQuery(q.tickets(query))
  const projects = useQuery(q.projects())
  const projectNames = useMemo(() => new Map((projects.data ?? []).map((p) => [p.id, p.name])), [projects.data])
  const openCreate = useUi((s) => s.openCreateTicket)
  const [text, setText] = useState(search.q ?? "")
  useEffect(() => setText(search.q ?? ""), [search.q])
  useEffect(() => {
    const id = setTimeout(() => {
      if ((text || undefined) !== search.q) onSearch({ ...search, q: text || undefined })
    }, 250)
    return () => clearTimeout(id)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  const view = search.view ?? "board"
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <h1 className="text-[13px] font-semibold">{title}</h1>
        <span className="text-xs text-fg-subtle">{tickets.data?.length ?? ""}</span>
        <div className="flex-1" />
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter…" className="w-56 pl-7" data-testid="filter" />
        </div>
        <Select value={search.source ?? ""} onChange={(e) => onSearch({ ...search, source: (e.target.value || undefined) as TicketSource })}>
          <option value="">All sources</option>
          <option value="local">Local</option>
          <option value="jira">Jira</option>
        </Select>
        {!fixedProjectId && (
          <Select value={search.project ?? ""} onChange={(e) => onSearch({ ...search, project: e.target.value || undefined })}>
            <option value="">All projects</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        <div className="flex rounded-md border p-0.5">
          <button
            className={cn("rounded px-1.5 py-0.5", view === "board" ? "bg-bg-muted text-fg" : "text-fg-subtle")}
            onClick={() => onSearch({ ...search, view: "board" })}
            aria-label="Board view"
          >
            <Columns3 className="size-3.5" />
          </button>
          <button
            className={cn("rounded px-1.5 py-0.5", view === "list" ? "bg-bg-muted text-fg" : "text-fg-subtle")}
            onClick={() => onSearch({ ...search, view: "list" })}
            aria-label="List view"
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
        ) : view === "board" ? (
          <Board
            tickets={tickets.data ?? []}
            query={query}
            projectNames={fixedProjectId ? undefined : projectNames}
            defaultProjectId={projectId}
          />
        ) : (
          <TicketList tickets={tickets.data ?? []} projectNames={fixedProjectId ? undefined : projectNames} />
        )}
      </div>
    </div>
  )
}
