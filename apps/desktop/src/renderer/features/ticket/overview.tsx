import type { HarnessId, HarnessModel, Priority, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  ArrowRight,
  Bot,
  Copy,
  ExternalLink,
  FileDiff,
  FolderGit2,
  FolderSearch,
  GitBranch,
  GitCommitHorizontal,
  Hand,
  Play,
  Plus,
  Trash2,
  Workflow,
  X
} from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  HARNESS_LABELS,
  PRIORITIES,
  PriorityIcon,
  RunStatusBadge,
  SessionStateBadge,
  sourceLabel
} from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input, Select } from "@/components/ui/input"
import { Tooltip } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { bridge, openExternal } from "@/lib/connection"
import { q } from "@/lib/queries"
import { cn, relativeTime } from "@/lib/utils"
import { RichText } from "../session/rich-text"
import { ActivityTimeline } from "./activity-timeline"
import type { TicketTab } from "./ticket-detail"

type UpdateBody = Parameters<typeof api.updateTicket>[1]

export const Overview = ({ ticket, onUpdate, onTab }: { ticket: Ticket; onUpdate: (b: UpdateBody) => void; onTab: (t: TicketTab) => void }) => {
  const editable = ticket.source === "local"
  const activity = useQuery(q.ticketActivity(ticket.id))

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 px-10 py-8">
        <div className="mx-auto max-w-3xl space-y-8">
          <div className="space-y-1">
            {editable ? (
              <EditableText
                value={ticket.title}
                onCommit={(title) => title.trim() && onUpdate({ title: title.trim() })}
                singleLine
                className="text-2xl font-semibold tracking-tight"
                placeholder="Ticket title"
              />
            ) : (
              <h2 className="text-2xl font-semibold tracking-tight">{ticket.title}</h2>
            )}
            {!editable && (
              <p className="text-xs text-fg-subtle">Title and description are synced read-only from {sourceLabel(ticket.source)}.</p>
            )}
          </div>

          <AgentCard ticket={ticket} onTab={onTab} />

          <Block title="Description">
            {editable ? (
              <EditableText
                value={ticket.description}
                onCommit={(description) => onUpdate({ description })}
                placeholder="Add a description…"
                className="min-h-24 text-[14px] leading-relaxed"
              />
            ) : ticket.description ? (
              <div className="text-[14px] leading-relaxed">
                <RichText text={ticket.description} />
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">No description</p>
            )}
          </Block>

          <Block title="Acceptance criteria" hint="One criterion per line; the agent sees them as its definition of done.">
            <EditableText
              value={ticket.acceptanceCriteria}
              onCommit={(acceptanceCriteria) => onUpdate({ acceptanceCriteria })}
              placeholder="What does done look like?"
              className="min-h-16 text-[14px] leading-relaxed"
            />
          </Block>

          <Block
            title="Recent activity"
            action={
              <button onClick={() => onTab("history")} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
                View all <ArrowRight className="size-3" />
              </button>
            }
          >
            {activity.data?.length ? (
              <ActivityTimeline events={activity.data.slice(0, 5)} />
            ) : (
              <p className="text-sm text-fg-subtle">Nothing yet.</p>
            )}
          </Block>
        </div>
      </div>
      <Sidebar ticket={ticket} onUpdate={onUpdate} />
    </div>
  )
}

// ---- agent status ------------------------------------------------------------------

const AgentCard = ({ ticket, onTab }: { ticket: Ticket; onTab: (t: TicketTab) => void }) => {
  const qc = useQueryClient()
  const project = useQuery(q.project(ticket.projectId))
  const sessions = useQuery({ ...q.ticketSessions(ticket.id), refetchInterval: ticket.activeSessionId ? 3_000 : false })
  const diff = useQuery({ ...q.ticketDiff(ticket.id), refetchInterval: 10_000 })
  const start = useMutation({
    mutationFn: () => api.startSession(ticket.id, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["tickets"] })
      onTab("agent")
    }
  })

  const harness = ticket.harness ?? project.data?.defaultHarness
  const session = sessions.data?.find((s) => s.id === ticket.activeSessionId) ?? sessions.data?.[0]
  const run = ticket.latestRun
  const live = !!ticket.activeSessionId && !!session && ["starting", "running", "idle", "waiting_for_approval"].includes(session.state)
  const needsInput = run?.needsInput || session?.state === "waiting_for_approval"
  const runActive = run && ["queued", "preparing", "running", "waiting_for_approval", "retrying"].includes(run.status)

  const files = diff.data?.files ?? []
  const added = files.reduce((n, f) => n + f.additions, 0)
  const removed = files.reduce((n, f) => n + f.deletions, 0)

  let icon = <Bot />
  let headline: React.ReactNode
  let detail: React.ReactNode
  let actions: React.ReactNode
  if (needsInput) {
    icon = <Hand />
    headline = "The agent is waiting for you"
    detail = "Approve or answer it to let the work continue."
    actions = (
      <Button onClick={() => onTab(run?.needsInput ? "workflow" : "agent")}>
        Respond <ArrowRight />
      </Button>
    )
  } else if (live) {
    headline = session.state === "idle" ? "The agent finished its turn" : "An agent is working on this"
    detail = (
      <span className="flex items-center gap-2">
        <SessionStateBadge state={session.state} />
        {HARNESS_LABELS[session.harness]} · started {relativeTime(session.createdAt)}
      </span>
    )
    actions = (
      <Button variant="secondary" onClick={() => onTab("agent")}>
        Open agent <ArrowRight />
      </Button>
    )
  } else if (runActive) {
    icon = <Workflow />
    headline = "A workflow is running"
    detail = <RunStatusBadge status={run.status} />
    actions = (
      <Button variant="secondary" onClick={() => onTab("workflow")}>
        Open workflow <ArrowRight />
      </Button>
    )
  } else {
    headline = session ? "No agent is running" : "Ready for an agent"
    detail = session ? (
      <span>
        Last session {session.state.replace(/_/g, " ")} {relativeTime(session.updatedAt)}.
      </span>
    ) : (
      <span>
        Starts {harness ? HARNESS_LABELS[harness] : "the project harness"}
        {ticket.model && <span className="font-mono text-[12px]"> ({ticket.model})</span>} in its own worktree and branch.
      </span>
    )
    actions = (
      <>
        <Button variant="secondary" onClick={() => onTab("workflow")}>
          <Workflow /> Run workflow
        </Button>
        <Button onClick={() => start.mutate()} disabled={start.isPending} data-testid="overview-start-agent">
          <Play /> {session ? "Start new session" : "Start agent"}
        </Button>
      </>
    )
  }

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-bg-subtle",
        needsInput && "border-warning/50",
        live && !needsInput && "border-accent/40"
      )}
    >
      <div className="flex items-center gap-3 p-4">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg bg-bg-muted text-fg-muted [&_svg]:size-4",
            needsInput && "bg-warning/15 text-warning",
            live && !needsInput && "bg-accent/15 text-accent"
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{headline}</div>
          <div className="mt-0.5 text-xs text-fg-muted">{detail}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      </div>
      {start.error && <p className="border-t px-4 py-2 text-xs text-danger">{(start.error as Error).message}</p>}
      {(diff.data?.branch || files.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-bg px-4 py-2.5 text-xs text-fg-muted">
          {diff.data?.branch && (
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{diff.data.branch}</span>
            </span>
          )}
          {diff.data && diff.data.commits.length > 0 && (
            <span className="flex items-center gap-1.5">
              <GitCommitHorizontal className="size-3.5" />
              {diff.data.commits.length} commit{diff.data.commits.length === 1 ? "" : "s"}
            </span>
          )}
          <button onClick={() => onTab("changes")} className="flex items-center gap-1.5 hover:text-fg">
            <FileDiff className="size-3.5" />
            {files.length} file{files.length === 1 ? "" : "s"} changed
            {files.length > 0 && (
              <span className="font-mono">
                <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
              </span>
            )}
          </button>
          <div className="flex-1" />
          <button onClick={() => onTab("files")} className="flex items-center gap-1 hover:text-fg">
            Browse files <ArrowRight className="size-3" />
          </button>
        </div>
      )}
    </section>
  )
}

// ---- sidebar -----------------------------------------------------------------------

const Sidebar = ({ ticket, onUpdate }: { ticket: Ticket; onUpdate: (b: UpdateBody) => void }) => {
  const qc = useQueryClient()
  const project = useQuery(q.project(ticket.projectId))
  const workspace = useQuery(q.ticketWorkspace(ticket.id))
  const workflows = useQuery(q.workflows())
  const del = useMutation({
    mutationFn: () => api.deleteTicket(ticket.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] })
  })
  const defaultWorkflow = workflows.data?.find((w) => w.id === project.data?.defaultWorkflowId)

  return (
    <aside className="w-80 shrink-0 space-y-7 border-l bg-bg-subtle/50 px-5 py-6">
      <SideSection title="Properties">
        <Prop label="Priority">
          <span className="flex w-full items-center gap-1.5">
            <PriorityIcon priority={ticket.priority} />
            <Select value={ticket.priority} onChange={(e) => onUpdate({ priority: e.target.value as Priority })} className={ghostSelect}>
              {PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </span>
        </Prop>
        <Prop label="Harness">
          <Select
            value={ticket.harness ?? ""}
            onChange={(e) => onUpdate({ harness: (e.target.value || null) as HarnessId | null })}
            className={ghostSelect}
          >
            <option value="">Default · {project.data ? HARNESS_LABELS[project.data.defaultHarness] : "…"}</option>
            {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => (
              <option key={h} value={h}>
                {HARNESS_LABELS[h]}
              </option>
            ))}
          </Select>
        </Prop>
        {project.data && (
          <ModelProps harness={ticket.harness ?? project.data.defaultHarness} value={ticket.model} onChange={(model) => onUpdate({ model })} />
        )}
        <Prop label="Workflow">
          <Select value={ticket.workflowId ?? ""} onChange={(e) => onUpdate({ workflowId: e.target.value || null })} className={ghostSelect}>
            <option value="">Default · {defaultWorkflow?.name ?? "none"}</option>
            {(workflows.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Prop>
        <Prop label="Labels" align="start">
          <LabelsEditor labels={ticket.labels} onChange={(labels) => onUpdate({ labels })} />
        </Prop>
      </SideSection>

      <SideSection title="Workspace">
        <Prop label="Project">
          <Link to="/projects/$projectId" params={{ projectId: ticket.projectId }} className="flex min-w-0 items-center gap-1.5 hover:underline">
            <FolderGit2 className="size-3.5 shrink-0 text-fg-muted" />
            <span className="truncate">{project.data?.name}</span>
          </Link>
        </Prop>
        {project.data && <PathProp label="Repository" path={project.data.repoPath} />}
        <Prop label="Branch">
          {workspace.data ? (
            <CopyValue value={workspace.data.branch} />
          ) : (
            <span className="text-fg-subtle">Created when an agent starts</span>
          )}
        </Prop>
        {workspace.data && <PathProp label="Worktree" path={workspace.data.path} />}
      </SideSection>

      {ticket.external && (
        <SideSection title={sourceLabel(ticket.external.provider)}>
          <Prop label="Key">
            <button className="flex items-center gap-1 text-accent hover:underline" onClick={() => openExternal(ticket.external!.url)}>
              {ticket.external.displayKey} <ExternalLink className="size-3" />
            </button>
          </Prop>
          <Prop label="Status">
            <Badge tone="info">{ticket.external.remoteStatus ?? "—"}</Badge>
          </Prop>
          <Prop label="Assignee">{ticket.external.remoteAssignee ?? "Unassigned"}</Prop>
          {ticket.external.remoteState === "missing" && (
            <p className="text-xs text-warning">No longer returned by the sync scope (deleted, moved or no permission). Local history is kept.</p>
          )}
          <p className="text-[11px] text-fg-subtle">Board moves stay local; AgentDesk never writes back to {sourceLabel(ticket.external.provider)}.</p>
        </SideSection>
      )}

      <div className="space-y-1 border-t pt-4 text-[11px] text-fg-subtle">
        <div>
          Created <time title={ticket.createdAt}>{relativeTime(ticket.createdAt)}</time> · Updated{" "}
          <time title={ticket.updatedAt}>{relativeTime(ticket.updatedAt)}</time>
        </div>
        {ticket.source === "local" && (
          <button
            className="flex items-center gap-1 pt-2 text-fg-subtle hover:text-danger"
            onClick={() => confirm("Delete this local ticket?") && del.mutate()}
            disabled={del.isPending}
          >
            <Trash2 className="size-3" /> Delete ticket
          </button>
        )}
        {del.error && <p className="text-danger">{(del.error as Error).message}</p>}
      </div>
    </aside>
  )
}

const ghostSelect = "h-7 min-w-0 flex-1 w-full -mx-1.5 border-transparent bg-transparent px-1.5 hover:border-border hover:bg-bg-muted"

/**
 * Model picker for the ticket's effective harness. Harnesses that route to several
 * providers (OpenCode) get a Provider picker first; the stored value stays `provider/model`.
 */
const ModelProps = ({ harness, value, onChange }: { harness: HarnessId; value: string | null; onChange: (model: string | null) => void }) => {
  const detections = useQuery(q.harnesses())
  const models: ReadonlyArray<HarnessModel> = detections.data?.find((d) => d.id === harness)?.models ?? []
  const [draft, setDraft] = useState(value ?? "")
  useEffect(() => setDraft(value ?? ""), [value])

  // No catalog (CLI missing or not reporting models): accept any model name.
  if (models.length === 0) {
    return (
      <Prop label="Model">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() !== (value ?? "") && onChange(draft.trim() || null)}
          placeholder={detections.isPending ? "Loading…" : "Harness default"}
          className="-mx-1.5 h-7 w-full border-transparent bg-transparent px-1.5 font-mono text-[12px] hover:border-border"
        />
      </Prop>
    )
  }

  const current = value ? models.find((m) => m.id === value) : undefined
  // Keep a value that is no longer offered (e.g. provider logged out) visible instead of silently dropping it.
  const unknown = value && !current ? [{ id: value, label: `${value} (unavailable)`, provider: value.split("/")[0] }] : []
  const options = [...models, ...unknown]
  const providers = [...new Set(options.flatMap((m) => (m.provider ? [m.provider] : [])))]
  const provider = (current ?? unknown[0])?.provider ?? ""
  const shown = providers.length > 0 ? options.filter((m) => m.provider === provider) : options

  return (
    <>
      {providers.length > 0 && (
        <Prop label="Provider">
          <Select value={provider} onChange={(e) => onChange(options.find((m) => m.provider === e.target.value)?.id ?? null)} className={ghostSelect}>
            <option value="">Harness default</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Prop>
      )}
      <Prop label="Model">
        <Select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={providers.length > 0 && !provider}
          className={ghostSelect}
        >
          <option value="">Harness default</option>
          {shown.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Prop>
    </>
  )
}

const LabelsEditor = ({ labels, onChange }: { labels: ReadonlyArray<string>; onChange: (labels: Array<string>) => void }) => {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState("")
  const commit = () => {
    const label = text.trim()
    if (label && !labels.includes(label)) onChange([...labels, label])
    setText("")
    setAdding(false)
  }
  return (
    <div className="flex flex-wrap items-center gap-1 py-1">
      {labels.map((l) => (
        <span key={l} className="group flex items-center gap-0.5 rounded-full border bg-bg px-2 py-0.5 text-[11px]">
          {l}
          <button
            onClick={() => onChange(labels.filter((x) => x !== l))}
            className="-mr-1 rounded-full p-0.5 text-fg-subtle opacity-0 group-hover:opacity-100 hover:text-fg"
            title={`Remove ${l}`}
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      {adding ? (
        <Input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") {
              setText("")
              setAdding(false)
            }
          }}
          className="h-6 w-24 text-[11px]"
          placeholder="label"
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] text-fg-subtle hover:bg-bg-muted hover:text-fg"
        >
          <Plus className="size-3" /> {labels.length ? "" : "Add label"}
        </button>
      )}
    </div>
  )
}

const PathProp = ({ label, path }: { label: string; path: string }) => (
  <Prop label={label}>
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-[11px] text-fg-muted" title={path} dir="rtl">
        {/* rtl keeps the meaningful end of the path visible; the bdi stops "/" from jumping. */}
        <bdi>{path.replace(/^\/Users\/[^/]+/, "~")}</bdi>
      </span>
      {bridge() && (
        <Tooltip content="Reveal in Finder">
          <button className="shrink-0 rounded p-1 text-fg-subtle hover:bg-bg-muted hover:text-fg" onClick={() => void bridge()!.revealPath(path)}>
            <FolderSearch className="size-3" />
          </button>
        </Tooltip>
      )}
    </span>
  </Prop>
)

const CopyValue = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-[11px] text-fg-muted" title={value}>
        {value}
      </span>
      <Tooltip content={copied ? "Copied" : "Copy"}>
        <button
          className="shrink-0 rounded p-1 text-fg-subtle hover:bg-bg-muted hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          <Copy className="size-3" />
        </button>
      </Tooltip>
    </span>
  )
}

// ---- building blocks ---------------------------------------------------------------

const Block = ({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <section className="space-y-2">
    <header className="flex items-baseline justify-between gap-2">
      <h3 className="text-xs font-medium text-fg-muted" title={hint}>
        {title}
      </h3>
      {action}
    </header>
    {children}
  </section>
)

const SideSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section>
    <h3 className="mb-2 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{title}</h3>
    <div className="space-y-0.5">{children}</div>
  </section>
)

const Prop = ({ label, align = "center", children }: { label: string; align?: "center" | "start"; children: React.ReactNode }) => (
  <div className={cn("grid min-h-8 grid-cols-[84px_1fr] gap-2 text-[13px]", align === "center" ? "items-center" : "items-start")}>
    <span className={cn("text-fg-muted", align === "start" && "pt-1.5")}>{label}</span>
    <div className="flex min-w-0 items-center">{children}</div>
  </div>
)

/** Borderless text that reads like the page until hovered or focused; grows with its content. */
const EditableText = ({
  value,
  onCommit,
  placeholder,
  className,
  singleLine
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
  className?: string
  singleLine?: boolean
}) => {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setDraft(value), [value])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${el.scrollHeight}px`
  }, [draft])
  return (
    <textarea
      ref={ref}
      rows={1}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(singleLine ? e.target.value.replace(/\n/g, " ") : e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (singleLine && e.key === "Enter") {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === "Escape") {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      className={cn(
        "-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-2 py-1 text-fg placeholder:text-fg-subtle hover:bg-bg-subtle focus:border-border focus:bg-bg-subtle focus:outline-none",
        className
      )}
    />
  )
}

