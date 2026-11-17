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
import { Transcript } from "./transcript"
import { useSessionEvents } from "./use-session-events"

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
      <SessionView key={selected.id} session={selected} />
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

const SessionView = ({ session }: { session: AgentSession }) => {
  const { items, connected, lastId } = useSessionEvents(session.id)
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
          <Transcript items={items} working={session.state === "running" || session.state === "starting"} onDecide={decide} deciding={deciding} />
        )}
      </div>
      <Composer
        onSend={(text, images) => api.prompt(session.id, text, images)}
        onInterrupt={() => void api.interrupt(session.id)}
        running={session.state === "running"}
        meta={`${HARNESS_LABELS[session.harness]} · ${session.state === "idle" ? "awaiting follow-up" : session.state.replace(/_/g, " ")}`}
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
