import type { Approval, StepRun, Ticket, WorkflowRunDetail } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  Bot,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  GitPullRequest,
  Hand,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Terminal,
  X,
  XCircle
} from "lucide-react"
import { useEffect, useState } from "react"
import { HARNESS_LABELS, RunStatusBadge } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { EmptyState, Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { openExternal } from "@/lib/connection"
import { q, qk } from "@/lib/queries"
import { cn, relativeTime } from "@/lib/utils"
import { RichText } from "../session/rich-text"

const KIND_ICON: Record<string, React.ReactNode> = {
  agent: <Bot />,
  approval: <Hand />,
  command: <Terminal />,
  pull_request: <GitPullRequest />
}

export const WorkflowTab = ({ ticket }: { ticket: Ticket }) => {
  const runs = useQuery(q.ticketRuns(ticket.id))
  const [selected, setSelected] = useState<string | undefined>()
  const runId = selected ?? runs.data?.[0]?.id
  if (runs.isLoading) return <Spinner />
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <StartRun ticket={ticket} hasActive={!!runs.data?.some((r) => !["completed", "failed", "cancelled", "interrupted"].includes(r.status))} />
      {runs.data && runs.data.length > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">Run</span>
          <Select aria-label="Workflow run" className="min-w-0 flex-1" value={runId} onChange={(e) => setSelected(e.target.value)}>
            {runs.data.map((r) => (
              <option key={r.id} value={r.id}>
                {r.workflowId} v{r.workflowVersion} · {r.status} · {relativeTime(r.createdAt)}
              </option>
            ))}
          </Select>
        </div>
      )}
      {runId ? <RunView runId={runId} ticket={ticket} /> : <EmptyState title="No workflow runs yet" />}
    </div>
  )
}

const StartRun = ({ ticket, hasActive }: { ticket: Ticket; hasActive: boolean }) => {
  const workflows = useQuery(q.workflows())
  const project = useQuery(q.project(ticket.projectId))
  const harnesses = useQuery(q.harnesses())
  const [workflowId, setWorkflowId] = useState("")
  const [harness, setHarness] = useState("")
  const qc = useQueryClient()
  useEffect(() => {
    if (!workflowId && workflows.data?.length) {
      setWorkflowId(ticket.workflowId ?? project.data?.defaultWorkflowId ?? workflows.data[0]!.id)
    }
  }, [workflows.data, project.data, ticket.workflowId, workflowId])
  const start = useMutation({
    mutationFn: () => api.startRun(ticket.id, { workflowId, harness: (harness || undefined) as never }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.ticketRuns(ticket.id) })
  })
  const wf = workflows.data?.find((w) => w.id === workflowId)
  return (
    <div className="rounded-lg border bg-bg-subtle p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select aria-label="Workflow" className="min-w-0 max-w-full sm:max-w-80" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} data-testid="workflow-select">
          {(workflows.data ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} (v{w.version})
            </option>
          ))}
        </Select>
        <Select value={harness} onChange={(e) => setHarness(e.target.value)} title="Override the harness for every agent step">
          <option value="">Harness per step</option>
          {(harnesses.data ?? []).filter((h) => h.installed).map((h) => (
            <option key={h.id} value={h.id}>
              All steps: {HARNESS_LABELS[h.id]}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <Button onClick={() => start.mutate()} disabled={!workflowId || start.isPending || hasActive} data-testid="start-run">
          {start.isPending ? <Spinner /> : <Play />} Start workflow
        </Button>
      </div>
      {wf && <div className="mt-2 text-[11px] text-fg-subtle">{wf.steps.map((s) => s.name).join(" → ")}</div>}
      {start.error && <p className="mt-2 text-xs text-danger">{(start.error as Error).message}</p>}
    </div>
  )
}

const RunView = ({ runId, ticket }: { runId: string; ticket: Ticket }) => {
  const run = useQuery({ ...q.run(runId), refetchInterval: (query) => (isLive(query.state.data) ? 3000 : false) })
  const qc = useQueryClient()
  const act = useMutation({
    mutationFn: (a: "cancel" | "resume" | "retry") =>
      a === "cancel" ? api.cancelRun(runId) : a === "resume" ? api.resumeRun(runId) : api.retryStep(runId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.run(runId) })
      void qc.invalidateQueries({ queryKey: qk.ticketRuns(ticket.id) })
    }
  })
  if (!run.data) return <Spinner />
  const r = run.data
  const pr = r.artifacts.find((a) => a.type === "pull_request")
  return (
    <div className="space-y-4" data-testid="run-view">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span data-testid="run-status" data-status={r.status}>
          <RunStatusBadge status={r.status} />
        </span>
        <span className="text-xs text-fg-muted">
          {r.workflowId} v{r.workflowVersion} · started {relativeTime(r.startedAt ?? r.createdAt)}
        </span>
        {r.workspace && <Badge tone="outline" className="font-mono">{r.workspace.branch}</Badge>}
        <div className="flex-1" />
        {pr?.url && (
          <Button size="sm" variant="secondary" onClick={() => openExternal(pr.url!)}>
            <GitPullRequest /> Open PR <ExternalLink />
          </Button>
        )}
        {isLive(r) && (
          <Button size="sm" variant="secondary" onClick={() => act.mutate("cancel")} disabled={act.isPending}>
            <Square /> Cancel
          </Button>
        )}
        {r.status === "interrupted" && (
          <Button size="sm" onClick={() => act.mutate("resume")} disabled={act.isPending}>
            <Play /> Resume
          </Button>
        )}
        {r.status === "failed" && (
          <Button size="sm" onClick={() => act.mutate("retry")} disabled={act.isPending}>
            <RotateCcw /> Retry failed step
          </Button>
        )}
      </div>
      {r.error && <p className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">{r.error}</p>}
      {act.error && <p className="text-xs text-danger">{(act.error as Error).message}</p>}
      <ol className="space-y-2">
        {r.plan.map((p) => (
          <StepCard key={p.id} plan={p} attempts={r.steps.filter((s) => s.stepId === p.id)} run={r} ticket={ticket} />
        ))}
      </ol>
    </div>
  )
}

const isLive = (r: WorkflowRunDetail | undefined) =>
  !!r && ["queued", "preparing", "running", "retrying", "waiting_for_approval"].includes(r.status)

const stateIcon = (s: StepRun["state"] | undefined) => {
  switch (s) {
    case "completed":
      return <CheckCircle2 className="size-4 text-success" />
    case "running":
      return <Loader2 className="size-4 animate-spin text-accent" />
    case "waiting_for_approval":
      return <Hand className="size-4 text-warning" />
    case "failed":
      return <XCircle className="size-4 text-danger" />
    case "cancelled":
    case "interrupted":
      return <Circle className="size-4 text-warning" />
    default:
      return <Circle className="size-4 text-fg-subtle" />
  }
}

const StepCard = ({
  plan,
  attempts,
  run,
  ticket
}: {
  plan: WorkflowRunDetail["plan"][number]
  attempts: ReadonlyArray<StepRun>
  run: WorkflowRunDetail
  ticket: Ticket
}) => {
  const last = attempts.at(-1)
  const approval = last ? run.approvals.find((a) => a.stepRunId === last.id && a.decision === null) : undefined
  const outputs = run.artifacts.filter((a) => attempts.some((s) => s.id === a.stepRunId))
  const [open, setOpen] = useState(false)
  return (
    <li
      className={cn("rounded-lg border bg-bg-subtle", last?.state === "running" && "border-accent/50", approval && "border-warning/60")}
      data-testid={`step-${plan.id}`}
    >
      <button className="flex w-full items-center gap-2.5 px-3 py-2 text-left" onClick={() => setOpen(!open)}>
        {stateIcon(last?.state)}
        <span className="text-fg-muted [&_svg]:size-3.5">{KIND_ICON[plan.kind]}</span>
        <span className="text-[13px] font-medium">{plan.name}</span>
        <span className="font-mono text-[11px] text-fg-subtle">{plan.id}</span>
        {attempts.length > 1 && <Badge tone="neutral">{attempts.length} attempts</Badge>}
        <div className="flex-1" />
        {last?.sessionId && (
          <Link
            to="/issues/$ticketId"
            params={{ ticketId: ticket.id }}
            search={{ tab: "agent", session: last.sessionId }}
            className="text-[11px] text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View session
          </Link>
        )}
        <span className="text-[11px] text-fg-subtle">{last?.state?.replace(/_/g, " ") ?? "pending"}</span>
      </button>
      {approval && <ApprovalGate approval={approval} />}
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {attempts.map((a) => (
            <div key={a.id} className="text-xs">
              <div className="flex items-center gap-2 text-fg-muted">
                {stateIcon(a.state)} Attempt {a.attempt} · {a.state.replace(/_/g, " ")} · {relativeTime(a.startedAt)}
              </div>
              {a.error && <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger">{a.error}</pre>}
            </div>
          ))}
          {outputs.map((a) => (
            <div key={a.id} className="rounded-md border bg-bg p-2">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
                <FileText className="size-3" /> {a.name} <Badge tone="outline">{a.type}</Badge>
              </div>
              {a.content && (a.type === "check" ? <pre className="max-h-64 overflow-auto font-mono text-[11px]">{a.content}</pre> : <RichText text={a.content} />)}
              {a.url && (
                <button className="text-xs text-accent hover:underline" onClick={() => openExternal(a.url!)}>
                  {a.url}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  )
}

const ApprovalGate = ({ approval }: { approval: Approval }) => {
  const [note, setNote] = useState("")
  const qc = useQueryClient()
  const decide = useMutation({
    mutationFn: (d: "allow" | "deny") => api.decide(approval.id, d, note || undefined),
    onSettled: () => qc.invalidateQueries({ queryKey: ["runs"] })
  })
  const details = approval.details as { content?: string | null; files?: Array<{ path: string; additions: number; deletions: number }>; branch?: string }
  return (
    <div className="space-y-2 border-t border-warning/40 bg-warning/5 px-3 py-2.5" data-testid="workflow-approval">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Hand className="size-3.5 text-warning" /> {approval.title}
      </div>
      {details.content && (
        <div className="max-h-80 overflow-y-auto rounded-md border bg-bg p-3">
          <RichText text={details.content} />
        </div>
      )}
      {details.files && (
        <div className="rounded-md border bg-bg p-2 font-mono text-[11px]">
          {details.files.map((f) => (
            <div key={f.path}>
              {f.path} <span className="text-success">+{f.additions}</span> <span className="text-danger">−{f.deletions}</span>
            </div>
          ))}
          {details.files.length === 0 && <span className="text-fg-subtle">No file changes</span>}
        </div>
      )}
      <div className="flex gap-2">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional feedback (sent to the agent on rejection)" />
        <Button size="sm" variant="secondary" onClick={() => decide.mutate("deny")} disabled={decide.isPending}>
          <X /> Reject
        </Button>
        <Button size="sm" variant="success" onClick={() => decide.mutate("allow")} disabled={decide.isPending} data-testid="approve-gate">
          <Check /> Approve
        </Button>
      </div>
      {decide.error && <p className="text-xs text-danger">{(decide.error as Error).message}</p>}
    </div>
  )
}

export const ChecksTab = ({ ticket }: { ticket: Ticket }) => {
  const runs = useQuery(q.ticketRuns(ticket.id))
  const runId = runs.data?.[0]?.id
  const run = useQuery({ ...q.run(runId ?? ""), enabled: !!runId })
  const checks = (run.data?.artifacts ?? []).filter((a) => a.type === "check")
  if (!runId) return <EmptyState icon={<Terminal />} title="No checks yet">Command steps of workflow runs report here.</EmptyState>
  return (
    <div className="mx-auto max-w-4xl space-y-3 p-6">
      {checks.length === 0 && <p className="text-xs text-fg-muted">No command output yet for the latest run.</p>}
      {checks.map((c) => {
        const step = run.data!.steps.find((s) => s.id === c.stepRunId)
        return (
          <div key={c.id} className="rounded-lg border bg-bg-subtle">
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
              {stateIcon(step?.state)} <span className="font-medium">{step?.stepId}</span>
              <span className="text-fg-subtle">attempt {step?.attempt}</span>
              <span className="ml-auto text-fg-subtle">{relativeTime(c.createdAt)}</span>
            </div>
            <pre className="max-h-96 overflow-auto p-3 font-mono text-[11px] leading-relaxed">{c.content}</pre>
          </div>
        )
      })}
      {run.data?.status === "failed" && (
        <Button size="sm" onClick={() => void api.retryStep(runId)}>
          <RotateCcw /> Retry failed step
        </Button>
      )}
    </div>
  )
}
