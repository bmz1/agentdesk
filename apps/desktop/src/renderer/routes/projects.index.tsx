import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { FolderGit2 } from "lucide-react"
import { HARNESS_LABELS } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/misc"
import { ProjectForm } from "@/features/projects/project-form"
import { q } from "@/lib/queries"

export const Route = createFileRoute("/projects/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.projects()),
  component: Projects
})

function Projects() {
  const projects = useQuery(q.projects())
  const navigate = Route.useNavigate()
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Projects</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl grid-cols-[1fr_380px] gap-6 p-6">
          <div className="space-y-2">
            {(projects.data ?? []).map((p) => (
              <Link
                key={p.id}
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="flex items-center gap-3 rounded-lg border bg-bg-subtle px-3 py-2.5 hover:border-border-strong"
              >
                <FolderGit2 className="size-4 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    {p.name} <span className="font-mono text-[11px] text-fg-subtle">{p.key}</span>
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg-subtle">{p.repoPath}</div>
                </div>
                <Badge tone="outline">{p.gitProvider}</Badge>
                <Badge tone="outline">{HARNESS_LABELS[p.defaultHarness]}</Badge>
              </Link>
            ))}
            {projects.data?.length === 0 && <p className="text-xs text-fg-muted">No projects yet. Register a git repository to start.</p>}
          </div>
          <Section title="Register a repository">
            <ProjectForm onDone={(p) => void navigate({ to: "/projects/$projectId", params: { projectId: p.id } })} />
          </Section>
        </div>
      </div>
    </div>
  )
}
