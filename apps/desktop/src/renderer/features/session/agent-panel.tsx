import type { AgentSession, HarnessId, PermissionMode, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Play, Power, Wifi, WifiOff } from "lucide-react"
import { useEffect, useState } from "react"
import { HARNESS_LABELS, SessionStateBadge } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Select, Textarea } from "@/components/ui/input"
import { EmptyState, Spinner, Tooltip } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { NeedsProject } from "../ticket/assign-project"
import { q, qk } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { relativeTime } from "@/lib/utils"
import { Composer } from "./composer"
import { ComposerModelPicker, ComposerPermissionPicker, usePermissionDefault } from "./model-picker"
import { type DecideFn, Transcript } from "./transcript"
import { useSessionEvents } from "./use-session-events"
import { useShortcut } from "@/lib/keymap"

export const AgentPanel = ({
  ticket,
  sessionId,
  onSelectSession
}: {
  ticket: Ticket
  sessionId: string | undefined
  onSelectSession: (id: string | undefined) => void
}) => {
  const sessions = useQuery(q.ticketSessions(ticket.id))
  const list = sessions.data ?? []
  const selectedId = sessionId ?? ticket.activeSessionId ?? list[0]?.id
  const selected = list.find((s) => s.id === selectedId)

  if (sessions.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (!selected) return <StartSession ticket={ticket} onStarted={(s) => onSelectSession(s.id)} />

  return (
    <div className="flex h-full flex-col">
      <SessionHeader sessions={list} selected={selected} onSelect={onSelectSession} ticket={ticket} />
      <SessionView key={selected.id} session={selected} ticket={ticket} />
    </div>
  )
}

const SessionHeader = ({
  sessions,
  selected,
  onSelect,
  ticket
}: {
  sessions: ReadonlyArray<AgentSession>
  selected: AgentSession
  onSelect: (id: string | undefined) => void
  ticket: Ticket
}) => {
  const qc = useQueryClient()
  const stop = useMutation({
    mutationFn: () => api.stopSession(selected.id),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.ticketSessions(ticket.id) })
  })
  const [starting, setStarting] = useState(false)
  const live = ["starting", "running", "waiting_for_approval", "idle"].includes(selected.state)
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <Bot className="size-4 shrink-0 text-fg-muted" />
      <Select value={selected.id} onChange={(e) => onSelect(e.target.value)} className="min-w-32 max-w-72 flex-1" aria-label="Agent session" data-testid="session-select">
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {HARNESS_LABELS[s.harness]} · {relativeTime(s.createdAt)} · {s.state}
          </option>
        ))}
      </Select>
      <SessionStateBadge state={selected.state} />
      <Tooltip content={selected.cwd}>
        <span className="min-w-0 max-w-48 truncate font-mono text-[11px] text-fg-subtle">{selected.cwd.split("/").slice(-2).join("/")}</span>
      </Tooltip>
      <div className="flex-1" />
      {live ? (
        <Button size="sm" variant="secondary" onClick={() => stop.mutate()} disabled={stop.isPending}>
          <Power />
          Stop agent
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setStarting(true)}>
          <Play />
          New session
        </Button>
      )}
      {starting && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-24" onClick={() => setStarting(false)}>
          <div className="w-[560px] rounded-lg border bg-bg-elevated" onClick={(e) => e.stopPropagation()}>
            <StartSession
              ticket={ticket}
              onStarted={(s) => {
                setStarting(false)
                onSelect(s.id)
              }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

const SessionView = ({ session, ticket }: { session: AgentSession; ticket: Ticket }) => {
  const { items, plan, connected, lastId, hasEarlier, loadingEarlier, loadEarlier } = useSessionEvents(session.id)
  const project = useQuery(q.project(ticket.projectId))
  // The ticket's model applies when the session runs the ticket's own harness; otherwise the harness default
  // until switched here. `picked` is a switch not yet sent.
  const ticketHarness = ticket.harness ?? project.data?.defaultHarness
  const own = session.harness === ticketHarness
  type Switches = { model?: string | null; effort?: string | null; permissionMode?: PermissionMode | null }
  const [switched, setSwitched] = useState<Switches>({})
  const [picked, setPicked] = useState<Switches>({})
  const current = {
    model: switched.model !== undefined ? switched.model : own ? ticket.model : null,
    effort: switched.effort !== undefined ? switched.effort : own ? ticket.effort : null,
    // Permission modes mean the same to every harness: the ticket's applies to all its sessions.
    permissionMode: switched.permissionMode !== undefined ? switched.permissionMode : ticket.permissionMode
  }
  const model = picked.model !== undefined ? picked.model : current.model
  const effort = picked.effort !== undefined ? picked.effort : current.effort
  const permissionMode = picked.permissionMode !== undefined ? picked.permissionMode : current.permissionMode
  const permissionDefault = usePermissionDefault(project.data, session.harness)
  const markRead = useUi((s) => s.markSessionRead)
  useEffect(() => {
    const read = () => {
      if (document.visibilityState === "visible" && document.hasFocus() && lastId > 0) markRead(session.id, lastId)
    }
    read()
    window.addEventListener("focus", read)
    document.addEventListener("visibilitychange", read)
    return () => { window.removeEventListener("focus", read); document.removeEventListener("visibilitychange", read) }
  }, [session.id, lastId, markRead])
  const qc = useQueryClient()
  const [deciding, setDeciding] = useState<string | null>(null)
  const [decideError, setDecideError] = useState<string | null>(null)
  const decide: DecideFn = async (approvalId, decision, options) => {
    setDeciding(approvalId)
    setDecideError(null)
    try {
      await api.decide(approvalId, decision, options)
    } catch (e) {
      setDecideError((e as Error).message)
    } finally {
      setDeciding(null)
      void qc.invalidateQueries({ queryKey: ["approvals"] })
    }
  }
  const pendingApproval = items.findLast((i) => i.kind === "approval" && !i.decision)
  const pending = pendingApproval?.kind === "approval" ? pendingApproval : undefined
  const pendingId = pending?.approvalId
  // Questions are answered on their card: the allow/deny keys only act on tool approvals.
  const toolPending = !!pendingId && !pending?.question && !deciding
  useShortcut("approve", () => pendingId && void decide(pendingId, "allow"), toolPending)
  useShortcut("approveSession", () => pendingId && void decide(pendingId, "allow", { scope: "session" }), toolPending && !!pending?.canAllowForSession)
  useShortcut("deny", () => pendingId && void decide(pendingId, "deny"), toolPending)
  useShortcut("interrupt", () => void api.interrupt(session.id), session.state === "running")
  const live = ["starting", "running", "waiting_for_approval", "idle"].includes(session.state)
  const resumable = !live && !!session.providerSessionId
  return (
    <>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="absolute top-2 right-3 z-10">
          <Tooltip content={connected ? "Live stream connected" : "Reconnecting to daemon…"}>
            <span className={connected ? "text-success" : "text-warning"}>
              {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
            </span>
          </Tooltip>
        </div>
        {items.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <span className="shimmer">{live ? "Starting the agent…" : "No events recorded for this session."}</span>
          </div>
        ) : (
          <Transcript
            items={items}
            plan={plan}
            working={session.state === "running" || session.state === "starting"}
            onDecide={decide}
            deciding={deciding}
            hasEarlier={hasEarlier}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={() => void loadEarlier()}
          />
        )}
        {decideError && (
          <p role="alert" className="mx-auto w-full max-w-3xl px-6 pb-1 text-xs text-danger">
            {decideError}
          </p>
        )}
      </div>
      <Composer
        onSend={async (text, images) => {
          const change = {
            ...(model !== current.model && { model }),
            ...(effort !== current.effort && { effort }),
            ...(permissionMode !== current.permissionMode && { permissionMode })
          }
          await api.prompt(session.id, text, images, change)
          setSwitched((s) => ({ ...s, ...change }))
          setPicked({})
        }}
        onInterrupt={() => void api.interrupt(session.id)}
        running={session.state === "running"}
        meta={
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">{HARNESS_LABELS[session.harness]}</span>
            <ComposerModelPicker
              harness={session.harness}
              model={model}
              effort={effort}
              // A new model has its own effort levels: start from its default.
              onModel={(m) => setPicked({ model: m, effort: null })}
              onEffort={(e) => setPicked((p) => ({ ...p, effort: e }))}
              disabled={!live && !resumable}
            />
            <ComposerPermissionPicker
              value={permissionMode}
              projectDefault={permissionDefault}
              onChange={(m) => setPicked((p) => ({ ...p, permissionMode: m }))}
              disabled={!live && !resumable}
            />
            <span className="truncate">· {session.state === "idle" ? "awaiting follow-up" : session.state.replace(/_/g, " ")}</span>
          </span>
        }
        disabled={!live && !resumable}
        placeholder={
          live ? undefined : resumable ? "Send a follow-up to resume this conversation…" : "This session has ended. Start a new session."
        }
      />
    </>
  )
}

export const StartSession = (props: { ticket: Ticket; onStarted: (s: AgentSession) => void }) =>
  props.ticket.projectId ? <StartSessionForm {...props} /> : <NeedsProject ticket={props.ticket} />

const StartSessionForm = ({ ticket, onStarted }: { ticket: Ticket; onStarted: (s: AgentSession) => void }) => {
  const harnesses = useQuery(q.harnesses())
  const project = useQuery(q.project(ticket.projectId))
  const [picked, setHarness] = useState<HarnessId | "">("")
  // Until one is picked, the ticket's harness, else the project's default once it loads.
  const harness = picked || ticket.harness || project.data?.defaultHarness || ""
  const [prompt, setPrompt] = useState("")
  const qc = useQueryClient()
  const start = useMutation({
    mutationFn: () => api.startSession(ticket.id, { harness: harness || undefined, prompt: prompt || undefined }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.ticketSessions(ticket.id) })
      void qc.invalidateQueries({ queryKey: ["tickets"] })
      onStarted(s)
    }
  })
  return (
    <div className="mx-auto w-full max-w-xl p-6">
      <EmptyState icon={<Bot />} title="Start an agent on this ticket">
        The agent runs in a dedicated git worktree, owned by the AgentDesk daemon. You can close this view; it keeps working.
      </EmptyState>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-20 text-xs text-fg-muted">Harness</span>
          <Select value={harness} onChange={(e) => setHarness(e.target.value as HarnessId)} className="flex-1" data-testid="harness-select">
            {(harnesses.data ?? []).map((h) => (
              <option key={h.id} value={h.id} disabled={!h.installed}>
                {HARNESS_LABELS[h.id]}
                {h.version ? ` ${h.version}` : ""}
                {!h.installed ? " (not installed)" : ""}
              </option>
            ))}
          </Select>
        </div>
        <Textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Optional instructions. The ticket title, description and acceptance criteria are included automatically."
          data-testid="start-prompt"
        />
        {start.error && <p className="text-xs text-danger">{(start.error as Error).message}</p>}
        <div className="flex justify-end">
          <Button onClick={() => start.mutate()} disabled={start.isPending || !harness} data-testid="start-session">
            {start.isPending ? <Spinner /> : <Play />}
            Start agent
          </Button>
        </div>
      </div>
    </div>
  )
}
