import type { HarnessId, PermissionMode, Priority, Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { HARNESS_LABELS, PRIORITIES } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Spinner } from "@/components/ui/misc"
import { modeCaveat, PERMISSION_MODES } from "@/features/projects/project-form"
import { modelLabel, permissionLabel, useHarnessOptions, usePermissionDefault } from "@/features/session/model-picker"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"

type AgentPick = { harness?: HarnessId; model: string | null; effort: string | null }
const NO_PICK: AgentPick = { model: null, effort: null }

/** A thread's name: the first line of what the user asked, trimmed to fit lists. */
export const threadTitle = (prompt: string) => {
  const line =
    prompt
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
      ?.replace(/\s+/g, " ") ?? "New thread"
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

export const CreateTicketDialog = () => {
  const open = useUi((s) => s.createTicketOpen)
  const close = useUi((s) => s.closeCreateTicket)
  const presetProject = useUi((s) => s.createTicketProjectId)
  const presetKind = useUi((s) => s.createKind)
  const projects = useQuery(q.projects())
  const qc = useQueryClient()
  const navigate = useNavigate()
  // These drafts intentionally survive closing the dialog, but clear after success.
  const [pickedProject, setProjectId] = useState("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [acceptance, setAcceptance] = useState("")
  const [priority, setPriority] = useState<Priority>("none")
  const [harness, setHarness] = useState<HarnessId | "">("")
  const [agentPick, setAgentPick] = useState<AgentPick>(NO_PICK)
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null)
  const [created, setCreated] = useState<Ticket | null>(null)
  const [kind, setKind] = useState<"thread" | "ticket">(presetKind)
  const [prompt, setPrompt] = useState("")
  const isThread = kind === "thread"

  // Each opening starts from what the opener asked for, unless a created ticket is still waiting
  // for its agent. Adjusted during render so the dialog never paints the previous opening's choice.
  const openedFor = open ? `${presetKind}:${presetProject ?? ""}` : null
  const [seenOpening, setSeenOpening] = useState<string | null>(null)
  if (openedFor !== seenOpening) {
    setSeenOpening(openedFor)
    if (openedFor !== null && !created) {
      setProjectId(presetProject ?? "")
      setKind(presetKind)
    }
  }
  const projectId = pickedProject || projects.data?.[0]?.id || ""
  const project = projects.data?.find((p) => p.id === projectId)
  const effectiveHarness = harness || project?.defaultHarness
  // Models and effort levels belong to one harness: another harness starts from its own defaults.
  const pick = agentPick.harness === effectiveHarness ? agentPick : NO_PICK
  const { model, effort } = pick
  const setModel = (value: string | null) => setAgentPick({ harness: effectiveHarness, model: value, effort: null })
  const setEffort = (value: string | null) => setAgentPick({ harness: effectiveHarness, model, effort: value })
  const options = useHarnessOptions(effectiveHarness, model, effort)
  const permissionDefault = usePermissionDefault(project, effectiveHarness)
  const installed = options.detection?.installed
  const mode = permissionMode ?? permissionDefault
  const modeHint = [PERMISSION_MODES.find((m) => m.id === mode)?.hint, mode && modeCaveat(mode, options.detection?.capabilities)]
    .filter(Boolean)
    .join(" ")

  const create = useMutation({
    mutationFn: async (start: boolean) => {
      const agent = { harness: harness || null, model, effort, permissionMode }
      const ticket =
        created ??
        (await api.createTicket(
          isThread
            ? { projectId, title: threadTitle(prompt), tracked: false, ...agent }
            : { projectId, title: title.trim(), description, acceptanceCriteria: acceptance, priority, ...agent }
        ))
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
      setTitle("")
      setDescription("")
      setAcceptance("")
      setPriority("none")
      setHarness("")
      setAgentPick(NO_PICK)
      setPermissionMode(null)
      setCreated(null)
      setPrompt("")
      close()
      void navigate({
        to: "/issues/$ticketId",
        params: { ticketId: ticket.id },
        search: { tab: session ? "agent" : "overview", session: session?.id }
      })
    }
  })
  const busy = create.isPending
  const locked = busy || !!created

  const agentFields = (
    <section aria-label="Agent" className="space-y-3 rounded-lg border bg-bg/40 p-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Project">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-8" data-testid="ticket-project">
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Harness">
          <Select
            value={harness}
            onChange={(e) => setHarness(e.target.value as HarnessId | "")}
            className="h-8"
            data-testid="ticket-harness"
          >
            <option value="">Project default{project ? ` · ${HARNESS_LABELS[project.defaultHarness]}` : ""}</option>
            {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => (
              <option key={h} value={h}>
                {HARNESS_LABELS[h]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)] gap-3">
        <Field label="Model">
          <Select
            value={model ?? ""}
            onChange={(e) => setModel(e.target.value || null)}
            disabled={options.models.length === 0}
            className="h-8"
            data-testid="ticket-model"
          >
            <option value="">{options.defaultModel ? `Default · ${options.defaultModel}` : "Harness default"}</option>
            {options.models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelLabel(m)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Effort">
          <Select
            value={effort ?? ""}
            onChange={(e) => setEffort(e.target.value || null)}
            disabled={options.levels.length === 0}
            className="h-8"
            data-testid="ticket-effort"
          >
            <option value="">
              {options.defaultLevel ? `Default · ${options.defaultLevel}` : options.levels.length ? "Default" : "Not supported"}
            </option>
            {options.levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Permissions">
          <Select
            value={permissionMode ?? ""}
            onChange={(e) => setPermissionMode((e.target.value || null) as PermissionMode | null)}
            className="h-8"
            data-testid="ticket-permission"
          >
            <option value="">{permissionDefault ? `Default · ${permissionLabel(permissionDefault, true)}` : "Project default"}</option>
            {PERMISSION_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {modeHint && (
        <p className={cn("text-[11px]", mode === "unrestricted" ? "text-warning" : "text-fg-subtle")} data-testid="ticket-permission-hint">
          {modeHint}
        </p>
      )}
    </section>
  )
  const kindTabs = (
    <div role="tablist" aria-label="What to create" className="inline-flex rounded-md border p-0.5 text-xs">
      {(["thread", "ticket"] as const).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={kind === k}
          disabled={locked}
          onClick={() => setKind(k)}
          className={cn("rounded px-3 py-1 capitalize text-fg-muted disabled:opacity-60", kind === k && "bg-bg-muted text-fg")}
          data-testid={`create-kind-${k}`}
        >
          {k}
        </button>
      ))}
    </div>
  )
  const noProjects = projects.data?.length === 0 && <p className="text-xs text-warning">Register a project first in Projects.</p>
  const footer = (hint: React.ReactNode, actions: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3 rounded-b-lg border-t bg-bg/40 px-5 py-3">
      <p className="min-w-0 truncate text-[11px] text-fg-subtle">{hint}</p>
      <div className="flex shrink-0 gap-2">{actions}</div>
    </div>
  )

  if (isThread) {
    const canStart = !!prompt.trim() && !!projectId && !busy && installed !== false
    return (
      <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
        <DialogContent
          className="top-[8%] w-[760px]"
          title="New thread"
          description="Talk it through with an agent. Threads stay off the board until you track them."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (canStart) create.mutate(true)
            }}
          >
            <div className="space-y-4 p-5">
              {kindTabs}
              {noProjects}
              <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
                <Textarea
                  autoFocus
                  aria-label="Message"
                  rows={9}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canStart) {
                      e.preventDefault()
                      create.mutate(true)
                    }
                  }}
                  placeholder="What do you want to think through?"
                  className="min-h-48 resize-y px-3 py-2.5 text-sm leading-relaxed"
                  data-testid="thread-prompt"
                />
                {agentFields}
              </fieldset>
              {installed === false && !created && <p className="text-xs text-warning">This harness is not installed.</p>}
              {create.error && (
                <p role="alert" className="text-xs text-danger">
                  {created ? "Thread created; agent could not start. Retry below. " : ""}
                  {create.error.message}
                </p>
              )}
            </div>
            {footer(
              "Runs in its own worktree. You can change these later from the chat.",
              <>
                <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canStart} data-testid="thread-start">
                  {busy && <Spinner />}
                  {created ? "Retry start" : "Start thread"} <kbd className="ml-1 text-[10px] opacity-60">⌘↵</kbd>
                </Button>
              </>
            )}
          </form>
        </DialogContent>
      </Dialog>
    )
  }
  const canCreate = !!title.trim() && !!projectId && !busy
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent
        className="top-[8%] w-[760px]"
        title="New ticket"
        description="Create a local ticket for the board, or start an agent on it immediately."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canCreate) create.mutate(false)
          }}
        >
          <div className="space-y-4 p-5">
            {kindTabs}
            {noProjects}
            <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
              <div className="space-y-2">
                <Input
                  autoFocus
                  aria-label="Ticket title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What should we work on?"
                  className="h-10 px-3 text-sm"
                  data-testid="ticket-title"
                />
                <Textarea
                  aria-label="Description"
                  rows={6}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCreate && installed) {
                      e.preventDefault()
                      create.mutate(true)
                    }
                  }}
                  placeholder="Instructions or description (optional)"
                  className="min-h-32 resize-y px-3 py-2.5 text-sm leading-relaxed"
                  data-testid="ticket-description"
                />
              </div>
              {agentFields}
              <details>
                <summary className="cursor-pointer text-xs text-fg-muted">More options</summary>
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_12rem] gap-3">
                  <Textarea
                    aria-label="Acceptance criteria"
                    rows={3}
                    value={acceptance}
                    onChange={(e) => setAcceptance(e.target.value)}
                    placeholder="Acceptance criteria (optional)"
                  />
                  <Field label="Priority">
                    <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="h-8">
                      {PRIORITIES.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </details>
            </fieldset>
            {installed === false && !created && (
              <p className="text-xs text-warning">This harness is not installed. You can still create the ticket.</p>
            )}
            {create.error && (
              <p role="alert" className="text-xs text-danger">
                {created ? "Ticket created; agent could not start. Retry below or open the ticket. " : ""}
                {create.error.message}
              </p>
            )}
          </div>
          {footer(
            "Agent settings stay with the ticket and apply to every session started on it.",
            <>
              <Button type="button" variant="ghost" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button type="submit" variant="secondary" disabled={!canCreate} data-testid="ticket-create">
                {created ? "Open ticket" : "Create ticket"}
              </Button>
              <Button
                type="button"
                disabled={!canCreate || !installed}
                onClick={() => create.mutate(true)}
                data-testid="ticket-create-start"
              >
                {busy && <Spinner />}
                {created ? "Retry start" : "Create & start"} <kbd className="ml-1 text-[10px] opacity-60">⌘↵</kbd>
              </Button>
            </>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
