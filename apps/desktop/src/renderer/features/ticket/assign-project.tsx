import type { Ticket } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Select } from "@/components/ui/input"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * Assigns a ticket to a project, or moves it to another one. Tickets imported from a task
 * source start unassigned and can also be unassigned again; local tickets always keep a project.
 * The daemon refuses while an agent or workflow is active on the ticket.
 */
export const AssignProject = ({ ticket, className, placeholder = "Assign to project…" }: { ticket: Ticket; className?: string; placeholder?: string }) => {
  const qc = useQueryClient()
  const projects = useQuery(q.projects())
  const assign = useMutation({
    mutationFn: (projectId: string | null) => api.updateTicket(ticket.id, { projectId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tickets"] }),
    onError: (e: Error) => toast.error("Couldn't change the ticket's project", { description: e.message })
  })
  return (
    <Select
      className={cn("min-w-0", className)}
      value={ticket.projectId ?? ""}
      disabled={assign.isPending}
      aria-label={`Project for ${ticket.identifier}`}
      onChange={(e) => assign.mutate(e.target.value || null)}
      data-testid="assign-project"
    >
      {(!ticket.projectId || ticket.source !== "local") && <option value="">{ticket.projectId ? "Unassigned" : placeholder}</option>}
      {(projects.data ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  )
}

/** Shown where an agent or workflow would start on a ticket that has no project yet. */
export const NeedsProject = ({ ticket }: { ticket: Ticket }) => (
  <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-bg p-4 text-sm" data-testid="needs-project">
    <div className="min-w-0 flex-1">
      <p className="font-medium">Assign {ticket.identifier} to a project</p>
      <p className="text-xs text-fg-muted">Agents work in a worktree of the project's repository, so pick where this ticket belongs first.</p>
    </div>
    <AssignProject ticket={ticket} className="w-56" />
  </div>
)
