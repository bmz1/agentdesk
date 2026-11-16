import { useMutation, useQuery } from "@tanstack/react-query"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ChevronLeft, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Section, Spinner } from "@/components/ui/misc"
import { ProjectForm } from "@/features/projects/project-form"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/projects/$projectId/settings")({
  component: ProjectSettings
})

function ProjectSettings() {
  const { projectId } = Route.useParams()
  const project = useQuery(q.project(projectId))
  const navigate = useNavigate()
  const del = useMutation({ mutationFn: () => api.deleteProject(projectId), onSuccess: () => navigate({ to: "/projects" }) })
  if (!project.data) return <Spinner />
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <Link to="/projects/$projectId" params={{ projectId }} className="rounded p-1 text-fg-muted hover:bg-bg-muted">
          <ChevronLeft className="size-4" />
        </Link>
        <h1 className="text-[13px] font-semibold">{project.data.name} settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 p-6">
          <Section title="Project">
            <ProjectForm project={project.data} />
          </Section>
          <Section title="Danger zone">
            <div className="flex items-center justify-between text-xs">
              <span className="text-fg-muted">Remove the project from AgentDesk (the repository is untouched). Requires no tickets.</span>
              <Button variant="danger" size="sm" onClick={() => confirm("Remove project?") && del.mutate()}>
                <Trash2 /> Remove
              </Button>
            </div>
            {del.error && <p className="mt-2 text-xs text-danger">{(del.error as Error).message}</p>}
          </Section>
        </div>
      </div>
    </div>
  )
}
