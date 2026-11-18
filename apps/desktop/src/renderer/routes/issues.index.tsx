import { createFileRoute } from "@tanstack/react-router"
import { IssuesView, projectFilter, validateIssuesSearch } from "@/features/board/issues-view"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/issues/")({
  validateSearch: validateIssuesSearch,
  loaderDeps: ({ search }) => ({ project: search.project, source: search.source, q: search.q }),
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(q.tickets({ ...projectFilter(deps.project), source: deps.source, q: deps.q, pinned: undefined, tracked: true })),
  component: AllIssues
})

function AllIssues() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return <IssuesView title="All issues" search={search} onSearch={(s) => navigate({ search: s, replace: true })} />
}
