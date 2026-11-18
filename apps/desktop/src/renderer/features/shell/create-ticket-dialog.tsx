import type { HarnessId, Priority, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { HARNESS_LABELS, PRIORITIES } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"

/** A thread's name: the first line of what the user asked, trimmed to fit lists. */
export const threadTitle = (prompt: string) => {
  const line = prompt.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/\s+/g, " ") ?? "New thread"
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export const CreateTicketDialog = () => {
  const open = useUi((s) => s.createTicketOpen)
  const close = useUi((s) => s.closeCreateTicket)
  const presetProject = useUi((s) => s.createTicketProjectId)
  const presetKind = useUi((s) => s.createKind)
  const projects = useQuery(q.projects())
  const harnesses = useQuery(q.harnesses())
  const qc = useQueryClient()
  const navigate = useNavigate()
  // These drafts intentionally survive closing the dialog, but clear after success.
  const [projectId, setProjectId] = useState("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [acceptance, setAcceptance] = useState("")
  const [priority, setPriority] = useState<Priority>("none")
  const [harness, setHarness] = useState<HarnessId | "">("")
  const [created, setCreated] = useState<Ticket | null>(null)
  const [kind, setKind] = useState<"thread" | "ticket">(presetKind)
  const [prompt, setPrompt] = useState("")
  const isThread = kind === "thread"

  useEffect(() => {
    if (open && !created) setProjectId(presetProject ?? projects.data?.[0]?.id ?? "")
  }, [open, presetProject, projects.data, created])
  useEffect(() => {
    if (open && !created) setKind(presetKind)
  }, [open, presetKind, created])
  const projectHarness = projects.data?.find((p) => p.id === projectId)?.defaultHarness
  const effectiveHarness = harness || projectHarness
  const installed = harnesses.data?.find((h) => h.id === effectiveHarness)?.installed
  const create = useMutation({
    mutationFn: async (start: boolean) => {
      const ticket = created ?? await api.createTicket(
        isThread
          ? { projectId, title: threadTitle(prompt), harness: harness || null, tracked: false }
          : { projectId, title: title.trim(), description, acceptanceCriteria: acceptance, priority, harness: harness || null }
      )
      setCreated(ticket)
      void qc.invalidateQueries({ queryKey: ["tickets"] })
      // Keep the created ticket if startup fails so Retry never creates a duplicate.
      const session = start
        ? await api.startSession(ticket.id, { harness: harness || undefined, ...(isThread && { prompt: prompt.trim() }) })
        : undefined
      return { ticket, session }
    },
    onSuccess: ({ ticket, session }) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] })
      void qc.invalidateQueries({ queryKey: ["sessions"] })
      setTitle(""); setDescription(""); setAcceptance(""); setPriority("none"); setHarness(""); setCreated(null); setPrompt("")
      close()
      void navigate({ to: "/issues/$ticketId", params: { ticketId: ticket.id }, search: { tab: session ? "agent" : "overview", session: session?.id } })
    }
  })
  const busy = create.isPending
  const projectHarnessFields = (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Project"><Select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="ticket-project">
        {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select></Field>
      <Field label="Harness"><Select value={harness} onChange={(e) => setHarness(e.target.value as HarnessId)} data-testid="ticket-harness">
        <option value="">Project default{projectHarness ? ` · ${HARNESS_LABELS[projectHarness]}` : ""}</option>
        {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => <option key={h} value={h}>{HARNESS_LABELS[h]}</option>)}
      </Select></Field>
    </div>
  )
  const kindTabs = (
    <div role="tablist" aria-label="What to create" className="inline-flex rounded-md border p-0.5 text-xs">
      {(["thread", "ticket"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={kind === k}
          disabled={busy || !!created}
          onClick={() => setKind(k)}
          className={cn("rounded px-2.5 py-1 capitalize text-fg-muted disabled:opacity-60", kind === k && "bg-bg-muted text-fg")}
          data-testid={`create-kind-${k}`}
        >
          {k}
        </button>
      ))}
    </div>
  )
  if (isThread) {
    const canStart = !!prompt.trim() && !!projectId && !busy && installed !== false
    return (
      <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
        <DialogContent title="New thread" description="Talk it through with an agent. Threads stay off the board until you track them.">
          <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (canStart) create.mutate(true) }}>
            {kindTabs}
            {projects.data?.length === 0 && <p className="text-xs text-warning">Register a project first in Projects.</p>}
            <fieldset disabled={busy || !!created} className="space-y-3 disabled:opacity-60">
              <Textarea
                autoFocus
                aria-label="Message"
                rows={5}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canStart) { e.preventDefault(); create.mutate(true) } }}
                placeholder="What do you want to think through?"
                className="text-sm"
                data-testid="thread-prompt"
              />
              {projectHarnessFields}
            </fieldset>
            {installed === false && !created && <p className="text-xs text-warning">This harness is not installed.</p>}
            {create.error && <p role="alert" className="text-xs text-danger">{created ? "Thread created; agent could not start. Retry below. " : ""}{create.error.message}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
              <Button type="submit" disabled={!canStart} data-testid="thread-start">
                {busy && <Spinner />}{created ? "Retry start" : "Start thread"} <kbd className="ml-1 text-[10px] opacity-60">⌘↵</kbd>
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent title="New ticket" description="Create a local ticket for the board, or start an agent on it immediately.">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (title.trim() && projectId && !busy) create.mutate(false) }}>
          {kindTabs}
          {projects.data?.length === 0 && <p className="text-xs text-warning">Register a project first in Projects.</p>}
          <fieldset disabled={busy || !!created} className="space-y-3 disabled:opacity-60">
            <Input autoFocus aria-label="Ticket title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should we work on?" className="h-9 text-sm" data-testid="ticket-title" />
            <Textarea aria-label="Description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Instructions or description (optional)" data-testid="ticket-description" />
            {projectHarnessFields}
            <details><summary className="cursor-pointer text-xs text-fg-muted">More options</summary>
              <div className="mt-3 space-y-3">
                <Textarea aria-label="Acceptance criteria" rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="Acceptance criteria (optional)" />
                <Field label="Priority"><Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                  {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </Select></Field>
              </div>
            </details>
          </fieldset>
          {installed === false && !created && <p className="text-xs text-warning">This harness is not installed. You can still create the ticket.</p>}
          {create.error && <p role="alert" className="text-xs text-danger">{created ? "Ticket created; agent could not start. Retry below or open the ticket. " : ""}{create.error.message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
            <Button type="submit" variant="secondary" disabled={!title.trim() || !projectId || busy} data-testid="ticket-create">{created ? "Open ticket" : "Create ticket"}</Button>
            <Button type="button" disabled={!title.trim() || !projectId || busy || !installed} onClick={() => create.mutate(true)} data-testid="ticket-create-start">
              {busy && <Spinner />}{created ? "Retry start" : "Create & start"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
