import type { HarnessCapabilities, HarnessId, PermissionMode, Project } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { FolderOpen } from "lucide-react"
import { useState } from "react"
import { HARNESS_LABELS } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { bridge } from "@/lib/connection"
import { q } from "@/lib/queries"

/** How a harness actually enforces a mode, when it differs from the mode's description. */
export const modeCaveat = (mode: PermissionMode, capabilities: HarnessCapabilities | undefined) => {
  if (mode === "plan" && capabilities?.planMode === "read_only")
    return "This harness has no plan mode AgentDesk can turn on: plan only blocks changes (Codex runs read-only; OpenCode can't run shell commands while planning)."
  if (mode === "accept_edits" && capabilities?.acceptEdits === "auto_approved")
    return "This harness has no accept-edits mode: AgentDesk approves its edit requests for you."
  return undefined
}

export const PERMISSION_MODES: ReadonlyArray<{ id: PermissionMode; label: string; short: string; hint: string }> = [
  {
    id: "ask",
    label: "Ask for risky tools",
    short: "Ask",
    hint: "Agent tool calls that need permission show approval cards (recommended)."
  },
  {
    id: "accept_edits",
    label: "Auto-accept file edits",
    short: "Accept edits",
    hint: "File edits in the worktree are allowed; shell commands still ask."
  },
  {
    id: "auto",
    label: "Auto (agent reviews approvals)",
    short: "Auto",
    hint: "Claude's auto mode and Codex's auto-review approve routine actions and block risky ones; only escalations ask. OpenCode has no reviewer: it allows edits, web lookups and subagents, and asks for shell commands."
  },
  { id: "plan", label: "Plan only", short: "Plan", hint: "The agent may read and plan but not modify files." },
  {
    id: "unrestricted",
    label: "Unrestricted (sandbox only)",
    short: "Unrestricted",
    hint: "No approvals. A worktree is NOT a sandbox — only use inside an isolated sandbox."
  }
]

export const ProjectForm = ({ project, onDone }: { project?: Project; onDone?: (p: Project) => void }) => {
  const qc = useQueryClient()
  const workflows = useQuery(q.workflows())
  const defaults = useQuery(q.harnessSettings())
  const [name, setName] = useState(project?.name ?? "")
  const [key, setKey] = useState(project?.key ?? "")
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? "")
  const [defaultBranch, setDefaultBranch] = useState(project?.defaultBranch ?? "")
  const [harness, setHarness] = useState<HarnessId | "">(project?.defaultHarness ?? "")
  const [permissionMode, setPermissionMode] = useState<PermissionMode | "">(
    project && !project.inheritHarnessPermissions ? project.permissionMode : ""
  )
  const [testCommand, setTestCommand] = useState(project?.testCommand ?? "")
  const [setupCommand, setSetupCommand] = useState(project?.setupCommand ?? "")
  const [workflowId, setWorkflowId] = useState(project?.defaultWorkflowId ?? "")
  const save = useMutation({
    mutationFn: () =>
      project
        ? api.updateProject(project.id, {
            name,
            repoPath,
            defaultBranch: defaultBranch || undefined,
            defaultHarness: harness || undefined,
            permissionMode: permissionMode || undefined,
            inheritHarnessPermissions: !permissionMode,
            testCommand: testCommand || null,
            setupCommand: setupCommand.trim() || null,
            defaultWorkflowId: workflowId || null
          })
        : api.createProject({
            name,
            key: key || undefined,
            repoPath,
            defaultBranch: defaultBranch || undefined,
            defaultHarness: harness || undefined,
            permissionMode: permissionMode || undefined,
            inheritHarnessPermissions: !permissionMode,
            testCommand: testCommand || null,
            setupCommand: setupCommand.trim() || null,
            defaultWorkflowId: workflowId || null
          }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ["projects"] })
      onDone?.(p)
    }
  })
  const pick = async () => {
    const dir = await bridge()?.pickDirectory()
    if (dir) {
      setRepoPath(dir)
      if (!name) setName(dir.split("/").filter(Boolean).at(-1) ?? "")
    }
  }
  const mode = PERMISSION_MODES.find((m) => m.id === permissionMode)
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <div className="grid grid-cols-[1fr_120px] gap-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Payments service" data-testid="project-name" />
        </Field>
        <Field label="Key">
          <Input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="auto" disabled={!!project} />
        </Field>
      </div>
      <Field label="Repository path" hint="Agents never write here directly; each run gets its own git worktree.">
        <div className="flex gap-2">
          <Input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="/Users/me/src/repo"
            className="font-mono"
            data-testid="project-repo"
          />
          {bridge() && (
            <Button type="button" variant="secondary" onClick={() => void pick()}>
              <FolderOpen /> Browse
            </Button>
          )}
        </div>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Default branch">
          <Input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} placeholder="auto-detect" />
        </Field>
        <Field label="Default harness">
          <Select value={harness} onChange={(e) => setHarness(e.target.value as HarnessId | "")} data-testid="project-harness">
            {!project && <option value="">App default · {defaults.data ? HARNESS_LABELS[defaults.data.defaultHarness] : "…"}</option>}
            {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((h) => (
              <option key={h} value={h}>
                {HARNESS_LABELS[h]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default workflow">
          <Select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">None</option>
            {(workflows.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field
        label="Agent permissions"
        hint={mode?.hint ?? "Uses the selected harness’s permission default from Settings when a session starts."}
      >
        <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value as PermissionMode | "")}>
          <option value="">Use harness default</option>
          {PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Setup script"
        hint="Runs once in every new worktree before the agent starts, from the worktree. $AGENTDESK_ROOT_PATH is your main checkout, $AGENTDESK_WORKSPACE_PATH the worktree."
      >
        <Textarea
          value={setupCommand}
          onChange={(e) => setSetupCommand(e.target.value)}
          rows={3}
          placeholder={'pnpm install\ncp "$AGENTDESK_ROOT_PATH/.env" .env'}
          className="font-mono text-xs"
          data-testid="project-setup-command"
        />
      </Field>
      <Field label="Test command" hint="Used by workflow `command` steps that don't specify one.">
        <Input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="pnpm test" className="font-mono" />
      </Field>
      {save.error && <p className="text-xs text-danger">{(save.error as Error).message}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={!name || !repoPath || save.isPending} data-testid="project-save">
          {save.isPending && <Spinner />}
          {project ? "Save project" : "Register project"}
        </Button>
      </div>
    </form>
  )
}
