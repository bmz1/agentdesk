import type { HarnessId, Priority } from "@agentdesk/contracts"
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

export const CreateTicketDialog = () => {
  const open = useUi((s) => s.createTicketOpen)
  const close = useUi((s) => s.closeCreateTicket)
  const presetProject = useUi((s) => s.createTicketProjectId)
  const projects = useQuery(q.projects())
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [projectId, setProjectId] = useState("")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [acceptance, setAcceptance] = useState("")
  const [priority, setPriority] = useState<Priority>("none")
  const [harness, setHarness] = useState<HarnessId | "">("")

  useEffect(() => {
    if (open) setProjectId(presetProject ?? projects.data?.[0]?.id ?? "")
  }, [open, presetProject, projects.data])

  const create = useMutation({
    mutationFn: () =>
      api.createTicket({
        projectId,
        title,
        description,
        acceptanceCriteria: acceptance,
        priority,
        harness: harness || null
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ["tickets"] })
      setTitle("")
      setDescription("")
      setAcceptance("")
      setPriority("none")
      close()
      void navigate({ to: "/issues/$ticketId", params: { ticketId: t.id } })
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent title="New local ticket" description="Local tickets stay on this machine and are never published to Jira.">
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim() && projectId) create.mutate()
          }}
        >
          {projects.data?.length === 0 && <p className="text-xs text-warning">Register a project (repository) first in Projects.</p>}
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ticket title" className="h-9 text-sm" data-testid="ticket-title" />
          <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" data-testid="ticket-description" />
          <Textarea rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder="Acceptance criteria (optional)" />
          <div className="grid grid-cols-3 gap-2">
            <Field label="Project">
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="ticket-project">
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Harness">
              <Select value={harness} onChange={(e) => setHarness(e.target.value as HarnessId)}>
                <option value="">Project default</option>
                {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => (
                  <option key={h} value={h}>
                    {HARNESS_LABELS[h]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {create.error && <p className="text-xs text-danger">{(create.error as Error).message}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || !projectId || create.isPending} data-testid="ticket-create">
              {create.isPending && <Spinner />}
              Create ticket
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
