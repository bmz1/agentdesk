import type { Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { HARNESS_LABELS } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/input"
import { Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { reviewPrompt } from "@/lib/review"
import { useUi } from "@/lib/store"
import { DiffViewer } from "./diff-viewer"

export const ReviewChanges = ({ ticket, onSelectSession }: { ticket: Ticket; onSelectSession: (id: string) => void }) => {
  const diff = useQuery({ ...q.ticketDiff(ticket.id), refetchInterval: 5000 })
  const sessions = useQuery(q.ticketSessions(ticket.id))
  const project = useQuery(q.project(ticket.projectId))
  const detections = useQuery(q.harnesses())
  const stored = useUi((s) => s.reviewComments[ticket.id])
  const comments = stored ?? []
  const setComments = useUi((s) => s.setReviewComments)
  const [picked, setTarget] = useState("")
  const qc = useQueryClient()
  const available = (sessions.data ?? []).filter((s) => s.state === "idle" || (!s.runId && ["completed", "closed", "failed", "interrupted"].includes(s.state) && s.providerSessionId))
  const hasLiveSession = (sessions.data ?? []).some((s) => ["starting", "running", "idle", "waiting_for_approval"].includes(s.state))
  const installed = (detections.data ?? []).filter((h) => h.installed)
  // Until one is picked: the first session that can take feedback, else a new session on the ticket's harness.
  const target = picked || available[0]?.id || (project.data ? `new:${ticket.harness ?? project.data.defaultHarness}` : "")
  const unresolved = comments.filter((c) => !c.resolved)
  const send = useMutation({
    mutationFn: async () => {
      const batch = [...unresolved]
      const prompt = reviewPrompt(batch)
      if (!batch.length) throw new Error("Add an unresolved review comment first.")
      if (target.startsWith("new:")) {
        const harness = installed.find((h) => h.id === target.slice(4))?.id
        if (!harness) throw new Error("Choose an installed harness.")
        const session = await api.startSession(ticket.id, { harness, prompt })
        return { sessionId: session.id, batch }
      }
      if (!available.some((s) => s.id === target)) throw new Error("This session cannot receive feedback right now. Choose another destination.")
      await api.prompt(target, prompt)
      return { sessionId: target, batch }
    },
    onSuccess: ({ sessionId, batch }) => {
      const ids = new Set(batch.map((c) => c.id))
      // Read the latest draft so comments added during a request cannot be lost.
      setComments(ticket.id, (useUi.getState().reviewComments[ticket.id] ?? []).map((c) => ids.has(c.id) ? { ...c, sentAt: new Date().toISOString() } : c))
      void qc.invalidateQueries({ queryKey: qk.ticketSessions(ticket.id) })
      void qc.invalidateQueries({ queryKey: ["sessions"] })
      void qc.invalidateQueries({ queryKey: ["tickets"] })
      onSelectSession(sessionId)
    }
  })
  return (
    <div className="space-y-4 p-4" data-testid="review-changes">
      <section className="space-y-2 rounded-md border bg-bg-subtle p-3">
        <h2 className="text-xs font-medium">Review feedback · {unresolved.length} unresolved</h2>
        <p className="text-[11px] text-fg-muted">Add comments using + beside a diff line. Locations retain the original code if the diff changes.</p>
        {comments.map((c) => <div key={c.id} className="rounded border bg-bg p-2 text-xs">
          <div className="flex items-start gap-2"><span className="min-w-0 flex-1 break-all font-mono text-[11px]">{c.path} · {c.side}:{c.line}</span>
            <button type="button" disabled={send.isPending} className="text-accent" onClick={() => setComments(ticket.id, comments.map((x) => x.id === c.id ? { ...x, resolved: !x.resolved } : x))}>{c.resolved ? "Reopen" : "Resolve"}</button>
            <button type="button" disabled={send.isPending} className="text-fg-subtle hover:text-danger" onClick={() => setComments(ticket.id, comments.filter((x) => x.id !== c.id))}>Delete</button>
          </div>
          <p className={c.resolved ? "mt-1 whitespace-pre-wrap text-fg-subtle line-through" : "mt-1 whitespace-pre-wrap"}>{c.text}</p>
          {c.sentAt && <p className="mt-1 text-[11px] text-fg-subtle">Sent · verify the revision before resolving</p>}
        </div>)}
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Review feedback destination" value={target} onChange={(e) => setTarget(e.target.value)} className="min-w-0 flex-[1_1_12rem]" data-testid="review-target">
            <option value="" disabled>Choose an agent</option>
            {available.map((s) => <option key={s.id} value={s.id}>{HARNESS_LABELS[s.harness]} · {s.id.slice(-6)} · {s.state}</option>)}
            {installed.map((h) => <option key={h.id} value={`new:${h.id}`} disabled={hasLiveSession}>New {HARNESS_LABELS[h.id]} session{hasLiveSession ? " (stop current agent first)" : ""}</option>)}
          </Select>
          <Button size="sm" disabled={!unresolved.length || !target || send.isPending || (target.startsWith("new:") && hasLiveSession)} onClick={() => send.mutate()} data-testid="review-send">{send.isPending && <Spinner />}Send review comments</Button>
        </div>
        {send.error && <p role="alert" className="text-xs text-danger">{send.error.message}</p>}
        {send.isSuccess && <p role="status" className="text-xs text-success">Feedback sent. Comments stay here for verification.</p>}
      </section>
      {diff.isPending ? <Spinner /> : diff.error ? <p role="alert" className="text-xs text-danger">{diff.error.message}</p> : diff.data && <DiffViewer diff={diff.data} onComment={(anchor, text) => {
        const latest = useUi.getState().reviewComments[ticket.id] ?? []
        setComments(ticket.id, [...latest, { ...anchor, id: crypto.randomUUID(), text, resolved: false }])
      }} />}
    </div>
  )
}
