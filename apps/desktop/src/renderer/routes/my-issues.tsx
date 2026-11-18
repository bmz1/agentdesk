import { createFileRoute } from "@tanstack/react-router"
import { IssuesView, validateIssuesSearch } from "@/features/board/issues-view"

export const Route = createFileRoute("/my-issues")({
  validateSearch: validateIssuesSearch,
  component: MyIssues
})

function MyIssues() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return <IssuesView title="My issues" pinnedOnly search={search} onSearch={(s) => navigate({ search: s, replace: true })} />
}
