import { createFileRoute } from "@tanstack/react-router"
import { IssuesView, validateIssuesSearch } from "@/features/board/issues-view"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/issues/")({
  validateSearch: validateIssuesSearch,
  loaderDeps: ({ search }) => ({ project: search.project, source: search.source, q: search.q }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(q.tickets({ projectId: deps.project, source: deps.source, q: deps.q })),
  component: AllIssues
})

function AllIssues() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return <IssuesView title="All issues" search={search} onSearch={(s) => navigate({ search: s, replace: true })} />
}
