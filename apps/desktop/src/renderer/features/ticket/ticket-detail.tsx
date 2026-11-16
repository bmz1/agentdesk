import type { BoardStatus, HarnessId, Priority, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bot, ChevronLeft, ExternalLink, FileDiff, FolderGit2, History, Info, Pin, PinOff, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import {
  BOARD_COLUMNS,
  HARNESS_LABELS,
  PRIORITIES,
  RunStatusBadge,
  SourceBadge,
  StatusIcon
} from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { EmptyState, Section, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { openExternal } from "@/lib/connection"
import { q, qk } from "@/lib/queries"
import { relativeTime } from "@/lib/utils"
import { DiffViewer } from "../diff/diff-viewer"
import { RichText } from "../session/rich-text"
import { AgentPanel } from "../session/agent-panel"
import { ActivityTimeline } from "./activity-timeline"

export type TicketTab = "overview" | "agent" | "workflow" | "changes" | "checks" | "history"

export interface TicketTabsExtension {
  readonly id: TicketTab
  readonly label: string
  readonly icon: React.ReactNode
  readonly render: (ticket: Ticket) => React.ReactNode
}

/** Additional tabs registered by later features (workflow timeline, checks). */
export const ticketTabExtensions: Array<TicketTabsExtension> = []

export const TicketDetail = ({
  ticketId,
  tab,
  sessionId,
  onTab,
  onSession
}: {
  ticketId: string
  tab: TicketTab
  sessionId?: string
  onTab: (t: TicketTab) => void
  onSession: (id: string | undefined) => void
}) => {
  const ticket = useQuery(q.ticket(ticketId))
  const qc = useQueryClient()
  const update = useMutation({
    mutationFn: (b: Parameters<typeof api.updateTicket>[1]) => api.updateTicket(ticketId, b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: qk.ticket(ticketId) })
      const prev = qc.getQueryData<Ticket>(qk.ticket(ticketId))
      if (prev) qc.setQueryData(qk.ticket(ticketId), { ...prev, ...b })
      return { prev }
    },
    onError: (_e, _b, ctx) => ctx?.prev && qc.setQueryData(qk.ticket(ticketId), ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tickets"] })
  })

  if (ticket.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!ticket.data) return <EmptyState title="Ticket not found" />
  const t = ticket.data

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Link to="/issues" className="rounded p-1 text-fg-muted hover:bg-bg-muted">
          <ChevronLeft className="size-4" />
        </Link>
        <span className="font-mono text-xs text-fg-muted">{t.identifier}</span>
        <SourceBadge ticket={t} />
        {t.latestRun && <RunStatusBadge status={t.latestRun.status} />}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="ticket-heading">
          {t.title}
        </h1>
        <Select
          value={t.status}
          onChange={(e) => update.mutate({ status: e.target.value as BoardStatus })}
          title="Local board status (never written to Jira)"
          data-testid="ticket-status"
        >
          {BOARD_COLUMNS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
        <Button variant="ghost" size="icon" onClick={() => update.mutate({ pinned: !t.pinned })} title={t.pinned ? "Unpin" : "Pin to My issues"}>
          {t.pinned ? <PinOff /> : <Pin />}
        </Button>
      </header>
      <Tabs value={tab} onValueChange={(v) => onTab(v as TicketTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="overview">
            <Info /> Overview
          </TabsTrigger>
          <TabsTrigger value="agent" data-testid="tab-agent">
            <Bot /> Agent
            {t.latestRun?.needsInput && <span className="size-1.5 rounded-full bg-warning" />}
          </TabsTrigger>
          {ticketTabExtensions
            .filter((x) => x.id === "workflow")
            .map((x) => (
              <TabsTrigger key={x.id} value={x.id}>
                {x.icon} {x.label}
              </TabsTrigger>
            ))}
          <TabsTrigger value="changes" data-testid="tab-changes">
            <FileDiff /> Changes
          </TabsTrigger>
          {ticketTabExtensions
            .filter((x) => x.id === "checks")
            .map((x) => (
              <TabsTrigger key={x.id} value={x.id}>
                {x.icon} {x.label}
              </TabsTrigger>
            ))}
          <TabsTrigger value="history">
            <History /> History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
          <Overview ticket={t} onUpdate={(b) => update.mutate(b)} />
        </TabsContent>
        <TabsContent value="agent" className="min-h-0 flex-1">
          <AgentPanel ticket={t} sessionId={sessionId} onSelectSession={onSession} />
        </TabsContent>
        {ticketTabExtensions.map((x) => (
          <TabsContent key={x.id} value={x.id} className="min-h-0 flex-1 overflow-y-auto">
            {x.render(t)}
          </TabsContent>
        ))}
        <TabsContent value="changes" className="min-h-0 flex-1 overflow-y-auto p-4">
          <Changes ticketId={t.id} />
        </TabsContent>
        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-4">
          <HistoryTab ticketId={t.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

const Overview = ({ ticket, onUpdate }: { ticket: Ticket; onUpdate: (b: Parameters<typeof api.updateTicket>[1]) => void }) => {
  const project = useQuery(q.project(ticket.projectId))
  const workspace = useQuery(q.ticketWorkspace(ticket.id))
  const editable = ticket.source === "local"
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description)
  const [acceptance, setAcceptance] = useState(ticket.acceptanceCriteria)
  useEffect(() => {
    setTitle(ticket.title)
    setDescription(ticket.description)
    setAcceptance(ticket.acceptanceCriteria)
  }, [ticket.id, ticket.title, ticket.description, ticket.acceptanceCriteria])
  const qc = useQueryClient()
  const del = useMutation({ mutationFn: () => api.deleteTicket(ticket.id), onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] }) })

  return (
    <div className="grid grid-cols-[1fr_280px] gap-6 p-6">
      <div className="min-w-0 space-y-4">
        {editable ? (
          <>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== ticket.title && onUpdate({ title })}
              className="h-9 border-transparent bg-transparent px-0 text-lg font-semibold hover:border-border"
            />
            <Field label="Description">
              <Textarea
                rows={8}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => description !== ticket.description && onUpdate({ description })}
                placeholder="Add a description…"
              />
            </Field>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">{ticket.title}</h2>
            <div className="rounded-md border bg-bg-subtle p-3">
              {ticket.description ? <RichText text={ticket.description} /> : <span className="text-fg-subtle">No description</span>}
            </div>
            <p className="text-[11px] text-fg-subtle">Title and description are synchronized read-only from Jira.</p>
          </>
        )}
        <Field label="Acceptance criteria">
          <Textarea
            rows={4}
            value={acceptance}
            onChange={(e) => setAcceptance(e.target.value)}
            onBlur={() => acceptance !== ticket.acceptanceCriteria && onUpdate({ acceptanceCriteria: acceptance })}
            placeholder="What does done look like?"
          />
        </Field>
      </div>
      <aside className="space-y-3">
        <Section title="Properties">
          <div className="space-y-2.5">
            <Prop label="Status">
              <span className="flex items-center gap-1.5">
                <StatusIcon status={ticket.status} /> {BOARD_COLUMNS.find((c) => c.id === ticket.status)?.label}
              </span>
            </Prop>
            <Prop label="Priority">
              <Select value={ticket.priority} onChange={(e) => onUpdate({ priority: e.target.value as Priority })} className="h-6 w-full">
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Prop>
            <Prop label="Harness">
              <Select
                value={ticket.harness ?? ""}
                onChange={(e) => onUpdate({ harness: (e.target.value || null) as HarnessId | null })}
                className="h-6 w-full"
              >
                <option value="">Project default ({project.data ? HARNESS_LABELS[project.data.defaultHarness] : "…"})</option>
                {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => (
                  <option key={h} value={h}>
                    {HARNESS_LABELS[h]}
                  </option>
                ))}
              </Select>
            </Prop>
            <Prop label="Project">
              <Link to="/projects/$projectId" params={{ projectId: ticket.projectId }} className="flex items-center gap-1 hover:underline">
                <FolderGit2 className="size-3.5" />
                {project.data?.name}
              </Link>
            </Prop>
            {project.data && (
              <Prop label="Repository">
                <span className="truncate font-mono text-[11px]" title={project.data.repoPath}>
                  {project.data.repoPath}
                </span>
              </Prop>
            )}
            <Prop label="Branch">
              {workspace.data ? (
                <span className="truncate font-mono text-[11px]" title={workspace.data.path}>
                  {workspace.data.branch}
                </span>
              ) : (
                <span className="text-fg-subtle">Created when an agent starts</span>
              )}
            </Prop>
            <Prop label="Updated">{relativeTime(ticket.updatedAt)}</Prop>
          </div>
        </Section>
        {ticket.external && (
          <Section title="Jira">
            <div className="space-y-2 text-xs">
              <Prop label="Key">
                <button className="flex items-center gap-1 text-accent hover:underline" onClick={() => openExternal(ticket.external!.url)}>
                  {ticket.external.displayKey} <ExternalLink className="size-3" />
                </button>
              </Prop>
              <Prop label="Remote status">
                <Badge tone="info">{ticket.external.remoteStatus ?? "—"}</Badge>
              </Prop>
              <Prop label="Assignee">{ticket.external.remoteAssignee ?? "Unassigned"}</Prop>
              {ticket.external.remoteState === "missing" && (
                <p className="text-warning">No longer returned by the sync scope (deleted, moved or no permission). Local history is kept.</p>
              )}
              <p className="text-fg-subtle">Board moves stay local; AgentDesk never writes to Jira.</p>
            </div>
          </Section>
        )}
        {ticket.labels.length > 0 && (
          <Section title="Labels">
            <div className="flex flex-wrap gap-1">
              {ticket.labels.map((l) => (
                <Badge key={l}>{l}</Badge>
              ))}
            </div>
          </Section>
        )}
        {editable && (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={() => confirm("Delete this local ticket?") && del.mutate()}
            disabled={del.isPending}
          >
            <Trash2 /> Delete ticket
          </Button>
        )}
        {del.error && <p className="text-xs text-danger">{(del.error as Error).message}</p>}
      </aside>
    </div>
  )
}

const Prop = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[80px_1fr] items-center gap-2 text-xs">
    <span className="text-fg-subtle">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
)

const Changes = ({ ticketId }: { ticketId: string }) => {
  const diff = useQuery({ ...q.ticketDiff(ticketId), refetchInterval: 5_000 })
  const workspace = useQuery(q.ticketWorkspace(ticketId))
  const qc = useQueryClient()
  const cleanup = useMutation({
    mutationFn: (force: boolean) => api.cleanupWorkspace(workspace.data!.id, force),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.ticketWorkspace(ticketId) })
  })
  if (diff.isLoading) return <Spinner />
  if (diff.error) return <p className="text-xs text-danger">{(diff.error as Error).message}</p>
  return (
    <div className="space-y-3">
      {workspace.data && (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <FolderGit2 className="size-3.5" />
          <span className="font-mono">{workspace.data.path}</span>
          <div className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => cleanup.mutate(false)} disabled={cleanup.isPending}>
            Remove worktree
          </Button>
        </div>
      )}
      {cleanup.error && (
        <div className="flex items-center gap-2 text-xs text-warning">
          {(cleanup.error as Error).message}
          <Button size="sm" variant="danger" onClick={() => confirm("Discard uncommitted changes and remove the worktree?") && cleanup.mutate(true)}>
            Force remove
          </Button>
        </div>
      )}
      {diff.data && <DiffViewer diff={diff.data} />}
    </div>
  )
}

const HistoryTab = ({ ticketId }: { ticketId: string }) => {
  const activity = useQuery(q.ticketActivity(ticketId))
  return activity.data ? <ActivityTimeline events={activity.data} /> : <Spinner />
}
