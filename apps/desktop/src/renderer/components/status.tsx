import type { BoardStatus, HarnessId, Priority, RunStatus, SessionState, Ticket } from "@agentdesk/contracts"
import {
  AlertOctagon,
  Bot,
  Braces,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleDot,
  CircleSlash,
  FlaskConical,
  Hand,
  Loader2,
  PauseCircle,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Sparkle,
  SquareTerminal,
  XCircle
} from "lucide-react"
import { Badge } from "./ui/badge"
import { SESSION_LABELS } from "@/lib/agent-state"
import { cn } from "@/lib/utils"

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardStatus; label: string }> = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "in_review", label: "In review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" }
]

export const statusLabel = (s: BoardStatus) => BOARD_COLUMNS.find((c) => c.id === s)?.label ?? s

export const StatusIcon = ({ status, className }: { status: BoardStatus; className?: string }) => {
  const cls = cn("size-3.5 shrink-0", className)
  switch (status) {
    case "todo":
      return <Circle className={cn(cls, "text-fg-subtle")} />
    case "in_progress":
      return <CircleDot className={cn(cls, "text-warning")} />
    case "in_review":
      return <CircleDashed className={cn(cls, "text-info")} />
    case "blocked":
      return <CircleSlash className={cn(cls, "text-danger")} />
    case "done":
      return <CheckCircle2 className={cn(cls, "text-accent")} />
  }
}

export const PRIORITIES: ReadonlyArray<{ id: Priority; label: string }> = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
  { id: "none", label: "No priority" }
]

export const PriorityIcon = ({ priority }: { priority: Priority }) => {
  switch (priority) {
    case "urgent":
      return <AlertOctagon className="size-3.5 text-danger" aria-label="Urgent" />
    case "high":
      return <SignalHigh className="size-3.5 text-fg-muted" aria-label="High" />
    case "medium":
      return <SignalMedium className="size-3.5 text-fg-muted" aria-label="Medium" />
    case "low":
      return <SignalLow className="size-3.5 text-fg-subtle" aria-label="Low" />
    case "none":
      return <span className="w-3.5 text-center text-fg-subtle">–</span>
  }
}

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  mock: "Mock"
}

const HARNESS_GLYPH: Record<HarnessId, { icon: typeof Bot; className: string }> = {
  claude: { icon: Sparkle, className: "bg-[#d97757]/15 text-[#d97757]" },
  codex: { icon: SquareTerminal, className: "bg-info/15 text-info" },
  opencode: { icon: Braces, className: "bg-success/15 text-success" },
  mock: { icon: FlaskConical, className: "bg-bg-muted text-fg-muted" }
}

/** Small tinted glyph identifying a harness (generic icons, not vendor logos). */
export const HarnessIcon = ({ harness, className }: { harness: HarnessId; className?: string }) => {
  const g = HARNESS_GLYPH[harness] ?? HARNESS_GLYPH.mock
  return (
    <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-[4px] [&_svg]:!size-2.5", g.className, className)} title={HARNESS_LABELS[harness]}>
      <g.icon />
    </span>
  )
}

export const HarnessBadge = ({ harness }: { harness: HarnessId | null }) =>
  harness ? (
    <Badge tone="outline">
      <Bot />
      {HARNESS_LABELS[harness]}
    </Badge>
  ) : null

/** Display name for a ticket source id ("jira" → "Jira"); unknown ids are title-cased. */
export const sourceLabel = (source: string) =>
  ({ local: "Local", jira: "Jira", linear: "Linear", github: "GitHub" })[source] ?? source.charAt(0).toUpperCase() + source.slice(1)

export const SourceBadge = ({ ticket }: { ticket: Ticket }) =>
  ticket.source !== "local" ? (
    <Badge tone={ticket.external?.remoteState === "missing" ? "warning" : "info"} title={ticket.external?.remoteStatus ?? undefined}>
      {sourceLabel(ticket.source)}
      {ticket.external?.remoteState === "missing" ? " · missing" : ""}
    </Badge>
  ) : (
    <Badge tone="neutral">Local</Badge>
  )

const runTone: Record<RunStatus, "neutral" | "accent" | "success" | "warning" | "danger" | "info"> = {
  queued: "neutral",
  preparing: "info",
  running: "accent",
  waiting_for_approval: "warning",
  retrying: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
  interrupted: "warning"
}

export const RunStatusBadge = ({ status }: { status: RunStatus }) => (
  <Badge tone={runTone[status]}>
    {status === "running" || status === "preparing" ? <Loader2 className="animate-spin" /> : null}
    {status === "waiting_for_approval" ? <Hand /> : null}
    {status === "failed" ? <XCircle /> : null}
    {status.replace(/_/g, " ")}
  </Badge>
)

const sessionTone: Record<SessionState, "neutral" | "accent" | "success" | "warning" | "danger" | "info"> = {
  starting: "info",
  running: "accent",
  idle: "success",
  waiting_for_approval: "warning",
  completed: "neutral",
  failed: "danger",
  interrupted: "warning",
  closed: "neutral"
}

export const SessionStateBadge = ({ state, compact = false }: { state: SessionState; compact?: boolean }) => compact ? (
  <span title={SESSION_LABELS[state]} aria-label={SESSION_LABELS[state]} className={cn("flex size-4 shrink-0 items-center justify-center", state === "waiting_for_approval" ? "text-warning" : state === "failed" || state === "interrupted" ? "text-danger" : "text-fg-subtle")}>
    {state === "starting" || state === "running" ? <Loader2 className="size-3 animate-spin text-accent" /> :
      state === "waiting_for_approval" ? <Hand className="size-3" /> :
      state === "failed" || state === "interrupted" ? <XCircle className="size-3" /> :
      state === "idle" ? <CircleDot className="size-3" /> : <CheckCircle2 className="size-3" />}
  </span>
) : (
  <Badge tone={sessionTone[state]}>
    {state === "running" || state === "starting" ? <Loader2 className="animate-spin" /> : null}
    {state === "waiting_for_approval" ? <Hand /> : null}
    {state === "interrupted" ? <PauseCircle /> : null}
    {SESSION_LABELS[state]}
  </Badge>
)

export const NeedsInputDot = () => (
  <span className="relative flex size-2" title="Agent needs your input">
    <span className="absolute inline-flex size-full animate-ping rounded-full bg-warning opacity-60 motion-reduce:hidden" />
    <span className="relative inline-flex size-2 rounded-full bg-warning" />
  </span>
)
