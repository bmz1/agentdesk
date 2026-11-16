import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Settings } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IssuesView, validateIssuesSearch } from "@/features/board/issues-view"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: validateIssuesSearch,
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.project(params.projectId)),
  component: ProjectBoard
})

function ProjectBoard() {
  const { projectId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const project = useQuery(q.project(projectId))
  return (
    <IssuesView
      title={
        <span>
          {project.data?.name} <span className="font-mono text-[11px] font-normal text-fg-subtle">{project.data?.key}</span>
        </span>
      }
      fixedProjectId={projectId}
      search={search}
      onSearch={(s) => navigate({ search: s, replace: true })}
      actions={
        <Button variant="ghost" size="icon" asChild>
          <Link to="/projects/$projectId/settings" params={{ projectId }} aria-label="Project settings">
            <Settings />
          </Link>
        </Button>
      }
    />
  )
}
