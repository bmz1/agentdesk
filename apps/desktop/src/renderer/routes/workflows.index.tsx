import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Workflow } from "lucide-react"
import { EmptyState, Spinner } from "@/components/ui/misc"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/workflows/")({
  component: Workflows
})

function Workflows() {
  const workflows = useQuery(q.workflows())
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Workflows</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {workflows.isLoading ? (
          <Spinner />
        ) : workflows.error || !workflows.data?.length ? (
          <EmptyState icon={<Workflow />} title="No workflows available">
            Workflow definitions are versioned YAML files loaded by the daemon.
          </EmptyState>
        ) : (
          <div className="mx-auto max-w-3xl space-y-2">
            {workflows.data.map((w) => (
              <Link
                key={w.id}
                to="/workflows/$workflowId"
                params={{ workflowId: w.id }}
                className="block rounded-lg border bg-bg-subtle px-3 py-2.5 hover:border-border-strong"
              >
                <div className="text-[13px] font-medium">
                  {w.name} <span className="font-mono text-[11px] text-fg-subtle">v{w.version}</span>
                </div>
                <div className="mt-1 text-[11px] text-fg-subtle">{w.steps.map((s) => s.id).join(" → ")}</div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
