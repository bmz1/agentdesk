import type { BoardStatus, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Bot, CheckSquare, ChevronLeft, FileDiff, FolderGit2, FolderTree, GitBranchPlus, History, Info, Pin, PinOff } from "lucide-react"
import { BOARD_COLUMNS, RunStatusBadge, SourceBadge } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/input"
import { EmptyState, Spinner, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { DiffViewer } from "../diff/diff-viewer"
import { FileBrowser } from "../files/file-browser"
import { AgentPanel } from "../session/agent-panel"
import { ChecksTab, WorkflowTab } from "../workflow/workflow-tab"
import { ActivityTimeline } from "./activity-timeline"
import { Overview } from "./overview"

export type TicketTab = "overview" | "agent" | "workflow" | "changes" | "files" | "checks" | "history"


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
          title="Local board status (never written back to the source)"
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
          <TabsTrigger value="workflow" data-testid="tab-workflow">
            <GitBranchPlus /> Workflow
          </TabsTrigger>
          <TabsTrigger value="changes" data-testid="tab-changes">
            <FileDiff /> Changes
          </TabsTrigger>
          <TabsTrigger value="files" data-testid="tab-files">
            <FolderTree /> Files
          </TabsTrigger>
          <TabsTrigger value="checks">
            <CheckSquare /> Checks
          </TabsTrigger>
          <TabsTrigger value="history">
            <History /> History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto">
          <Overview ticket={t} onUpdate={(b) => update.mutate(b)} onTab={onTab} />
        </TabsContent>
        <TabsContent value="agent" className="min-h-0 flex-1">
          <AgentPanel ticket={t} sessionId={sessionId} onSelectSession={onSession} />
        </TabsContent>
        <TabsContent value="workflow" className="min-h-0 flex-1 overflow-y-auto">
          <WorkflowTab ticket={t} />
        </TabsContent>
        <TabsContent value="checks" className="min-h-0 flex-1 overflow-y-auto">
          <ChecksTab ticket={t} />
        </TabsContent>
        <TabsContent value="changes" className="min-h-0 flex-1 overflow-y-auto p-4">
          <Changes ticketId={t.id} />
        </TabsContent>
        <TabsContent value="files" className="min-h-0 flex-1">
          <FileBrowser ticketId={t.id} onShowChanges={() => onTab("changes")} />
        </TabsContent>
        <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto">
          <HistoryTab ticketId={t.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

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
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      {activity.data ? <ActivityTimeline events={activity.data} groupByDay /> : <Spinner />}
    </div>
  )
}
