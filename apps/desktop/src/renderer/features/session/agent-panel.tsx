import type { AgentSession, HarnessId, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Bot, Play, Power, Wifi, WifiOff } from "lucide-react"
import { useEffect, useState } from "react"
import { HARNESS_LABELS, SessionStateBadge } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Select, Textarea } from "@/components/ui/input"
import { EmptyState, Spinner, Tooltip } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { relativeTime } from "@/lib/utils"
import { Composer } from "./composer"
import { ComposerModelPicker } from "./model-picker"
import { Transcript } from "./transcript"
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
  const { items, connected, lastId, hasEarlier, loadingEarlier, loadEarlier } = useSessionEvents(session.id)
  const project = useQuery(q.project(ticket.projectId))
  // The ticket's model applies when the session runs the ticket's own harness; otherwise the harness default
  // until switched here. `picked` is a switch not yet sent.
  const ticketHarness = ticket.harness ?? project.data?.defaultHarness
  const own = session.harness === ticketHarness
  const [switched, setSwitched] = useState<{ model?: string | null; effort?: string | null }>({})
  const [picked, setPicked] = useState<{ model?: string | null; effort?: string | null }>({})
  const current = {
    model: switched.model !== undefined ? switched.model : own ? ticket.model : null,
    effort: switched.effort !== undefined ? switched.effort : own ? ticket.effort : null
  }
  const model = picked.model !== undefined ? picked.model : current.model
  const effort = picked.effort !== undefined ? picked.effort : current.effort
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
  const decide = async (approvalId: string, decision: "allow" | "deny") => {
    setDeciding(approvalId)
    try {
      await api.decide(approvalId, decision)
    } finally {
      setDeciding(null)
      void qc.invalidateQueries({ queryKey: ["approvals"] })
    }
  }
  const pendingApproval = items.findLast((i) => i.kind === "approval" && !i.decision)
  const pendingId = pendingApproval?.kind === "approval" ? pendingApproval.approvalId : undefined
  useShortcut("approve", () => pendingId && void decide(pendingId, "allow"), !!pendingId && !deciding)
  useShortcut("deny", () => pendingId && void decide(pendingId, "deny"), !!pendingId && !deciding)
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
            working={session.state === "running" || session.state === "starting"}
            onDecide={decide}
            deciding={deciding}
            hasEarlier={hasEarlier}
            loadingEarlier={loadingEarlier}
            onLoadEarlier={() => void loadEarlier()}
          />
        )}
      </div>
      <Composer
        onSend={async (text, images) => {
          const change = {
            ...(model !== current.model && { model }),
            ...(effort !== current.effort && { effort })
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

export const StartSession = ({ ticket, onStarted }: { ticket: Ticket; onStarted: (s: AgentSession) => void }) => {
  const harnesses = useQuery(q.harnesses())
  const project = useQuery(q.project(ticket.projectId))
  const [harness, setHarness] = useState<HarnessId | "">("")
  const [prompt, setPrompt] = useState("")
  const qc = useQueryClient()
  useEffect(() => {
    if (!harness && project.data) setHarness(ticket.harness ?? project.data.defaultHarness)
  }, [project.data, ticket.harness, harness])
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
