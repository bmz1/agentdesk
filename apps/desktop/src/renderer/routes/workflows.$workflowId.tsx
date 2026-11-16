import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Spinner } from "@/components/ui/misc"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/workflows/$workflowId")({
  component: WorkflowDetail
})

function WorkflowDetail() {
  const { workflowId } = Route.useParams()
  const wf = useQuery(q.workflow(workflowId))
  if (!wf.data) return <Spinner />
  return (
    <div className="p-6">
      <h1 className="text-sm font-semibold">{wf.data.name}</h1>
      <pre className="mt-3 rounded-md border bg-bg-subtle p-3 font-mono text-xs">{wf.data.yaml}</pre>
    </div>
  )
}
