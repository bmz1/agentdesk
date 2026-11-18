import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Bot, CheckCircle2, ChevronLeft, GitPullRequest, Hand, Save, Terminal, XCircle } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import { Section, Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/workflows/$workflowId")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.workflow(params.workflowId)),
  component: WorkflowDetail
})

const ICONS: Record<string, React.ReactNode> = {
  agent: <Bot />,
  approval: <Hand />,
  command: <Terminal />,
  pull_request: <GitPullRequest />
}

function WorkflowDetail() {
  const { workflowId } = Route.useParams()
  const wf = useQuery(q.workflow(workflowId))
  // Unsaved edits, tagged with their workflow so navigating to another one shows its own YAML.
  const [edit, setEdit] = useState<{ workflowId: string; yaml: string } | null>(null)
  const yaml = edit?.workflowId === workflowId ? edit.yaml : wf.data?.yaml ?? ""
  const setYaml = (value: string) => setEdit({ workflowId, yaml: value })
  const qc = useQueryClient()
  const validate = useMutation({ mutationFn: () => api.validateWorkflow(yaml) })
  const save = useMutation({
    mutationFn: () => api.saveWorkflow(yaml),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["workflows"] })
      setEdit(null)
    }
  })
  if (!wf.data) return <Spinner />
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center gap-2 border-b px-4">
        <Link to="/workflows" className="rounded p-1 text-fg-muted hover:bg-bg-muted">
          <ChevronLeft className="size-4" />
        </Link>
        <h1 className="text-[13px] font-semibold">{wf.data.name}</h1>
        <Badge tone="outline">v{wf.data.version}</Badge>
        <span className="text-[11px] text-fg-subtle">versions: {wf.data.versions.join(", ")}</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-6xl grid-cols-[300px_1fr] gap-6 p-6">
          <Section title="Steps">
            <ol className="space-y-2">
              {wf.data.steps.map((s, i) => (
                <li key={s.id} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-right text-fg-subtle">{i + 1}</span>
                  <span className="text-fg-muted [&_svg]:size-3.5">{ICONS[s.kind]}</span>
                  <span>{s.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-fg-subtle">{s.id}</span>
                </li>
              ))}
            </ol>
          </Section>
          <Section
            title="Definition (YAML)"
            actions={
              <div className="flex gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => validate.mutate()}>
                  Validate
                </Button>
                <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
                  <Save /> Save as new version
                </Button>
              </div>
            }
          >
            <Textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              rows={28}
              spellCheck={false}
              className="font-mono text-[12px] leading-5"
            />
            <p className="mt-2 text-[11px] text-fg-subtle">
              Versions are immutable: bump <code className="font-mono">version</code> to save changes. Running workflows keep the version they started with.
            </p>
            {validate.data && (
              <div className={`mt-2 text-xs ${validate.data.ok ? "text-success" : "text-danger"}`}>
                {validate.data.ok ? (
                  <span className="flex items-center gap-1">
                    <CheckCircle2 className="size-3.5" /> Valid
                  </span>
                ) : (
                  validate.data.errors.map((e, i) => (
                    <div key={i} className="flex items-start gap-1">
                      <XCircle className="mt-0.5 size-3.5 shrink-0" /> {e}
                    </div>
                  ))
                )}
              </div>
            )}
            {save.error && <p className="mt-2 text-xs text-danger">{(save.error as Error).message}</p>}
            {save.data && <p className="mt-2 text-xs text-success">Saved {save.data.id} v{save.data.version}</p>}
          </Section>
        </div>
      </div>
    </div>
  )
}
