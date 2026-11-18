import type { Project, SourceConnection, SourceDescriptor, SourceField } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Plus, RefreshCw, Trash2, X, XCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Section, Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { relativeTime } from "@/lib/utils"

/**
 * Generic settings for every task source (Jira, Linear, …). Forms are rendered
 * from each source's descriptor, so adding a source needs no UI changes.
 * Connections are global: each imported task is routed to a project by its
 * remote project/team key, with an optional fallback project.
 */
export const SourcesSettings = () => {
  const sources = useQuery(q.sources())
  const connections = useQuery(q.sourceConnections())
  const [adding, setAdding] = useState(false)
  const byId = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data])
  return (
    <Section
      title="Task sources (read-only sync)"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAdding(!adding)} data-testid="add-source">
          <Plus /> Add connection
        </Button>
      }
    >
      <p className="mb-3 text-[11px] text-fg-subtle">
        AgentDesk imports tasks from {(sources.data ?? []).map((s) => s.displayName).join(", ") || "external trackers"} into
        your boards. A connection is not tied to one project: map each remote project (e.g. the SEON in SEON-12) to an
        AgentDesk project, or pick a fallback project for everything else. It never creates, edits, comments on or
        transitions remote tasks; moving a card changes the local board only. Tokens are stored in the OS credential store,
        never in the database.
      </p>
      {adding && sources.data && <NewConnection sources={sources.data} onDone={() => setAdding(false)} />}
      {connections.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {(connections.data ?? []).map((c) => (
            <ConnectionRow key={c.id} c={c} source={byId.get(c.provider)} />
          ))}
          {connections.data?.length === 0 && !adding && <p className="text-xs text-fg-muted">No task source connections.</p>}
        </div>
      )}
    </Section>
  )
}

const ConnectionRow = ({ c, source }: { c: SourceConnection; source: SourceDescriptor | undefined }) => {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.sourceConnections })
  const sync = useMutation({ mutationFn: (full: boolean) => api.syncSource(c.id, full), onSettled: invalidate })
  const test = useMutation({ mutationFn: () => api.testSource(c.id) })
  const toggle = useMutation({ mutationFn: () => api.updateSourceConnection(c.id, { enabled: !c.enabled }), onSettled: invalidate })
  const del = useMutation({ mutationFn: () => api.deleteSourceConnection(c.id), onSettled: invalidate })
  const [token, setToken] = useState("")
  const saveToken = useMutation({
    mutationFn: () => api.updateSourceConnection(c.id, { token }),
    onSuccess: () => setToken(""),
    onSettled: invalidate
  })
  const projects = useQuery(q.projects())
  const [editingRoutes, setEditingRoutes] = useState(false)
  const saveRouting = useMutation({
    mutationFn: (r: Routing) => api.updateSourceConnection(c.id, { projectId: r.projectId, projectRoutes: r.projectRoutes }),
    onSuccess: () => setEditingRoutes(false),
    onSettled: invalidate
  })
  const projectName = (id: string | null) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? "deleted project") : null)
  const scopeLabel = source?.scopeLabel ?? "Project"
  const routes = Object.entries(c.projectRoutes).sort(([a], [b]) => a.localeCompare(b))
  const unrouted = Object.entries(c.unrouted).sort(([a], [b]) => a.localeCompare(b))
  const settings = (c.settings ?? {}) as Record<string, unknown>
  return (
    <div className="rounded-md border bg-bg p-3 text-xs" data-testid="source-connection">
      <div className="flex items-center gap-2">
        <Badge tone="info">{source?.displayName ?? c.provider}</Badge>
        <span className="font-medium">{c.name}</span>
        {!c.enabled && <Badge tone="neutral">paused</Badge>}
        {c.lastError ? <Badge tone="danger">error</Badge> : c.lastSyncAt ? <Badge tone="success">ok</Badge> : null}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => test.mutate()} disabled={test.isPending}>
          Test
        </Button>
        <Button size="sm" variant="secondary" onClick={() => sync.mutate(false)} disabled={sync.isPending}>
          {sync.isPending ? <Spinner /> : <RefreshCw />} Sync
        </Button>
        <Button size="sm" variant="ghost" onClick={() => sync.mutate(true)} disabled={sync.isPending} title="Full sync detects tasks that left the scope">
          Full
        </Button>
        <Button size="sm" variant="ghost" onClick={() => toggle.mutate()}>
          {c.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => confirm("Remove connection? Imported tickets are kept.") && del.mutate()}>
          <Trash2 />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-[110px_1fr] gap-y-1 text-fg-muted">
        {(source?.fields ?? []).map((f) =>
          settings[f.key] !== undefined && settings[f.key] !== "" ? (
            <Row key={f.key} label={f.label}>
              <span className={f.type === "textarea" || f.type === "url" ? "font-mono" : ""}>
                {f.options?.find((o) => o.value === settings[f.key])?.label ?? String(settings[f.key])}
              </span>
            </Row>
          ) : null
        )}
        {!editingRoutes && (
          <Row label="Routing">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="source-routing">
              {routes.map(([scope, projectId]) => (
                <span key={scope}>
                  <span className="font-mono">{scope}</span> → {projectName(projectId)}
                </span>
              ))}
              <span>
                {routes.length > 0 ? "everything else" : `every ${scopeLabel}`} →{" "}
                {projectName(c.projectId) ?? <span className="text-fg-subtle">not imported</span>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEditingRoutes(true)} data-testid="edit-routing">
                Edit
              </Button>
            </span>
          </Row>
        )}
        {unrouted.length > 0 && !editingRoutes && (
          <Row label="Not imported">
            <span className="flex flex-wrap items-center gap-2" data-testid="source-unrouted">
              {unrouted.map(([scope, n]) => (
                <span key={scope} className="flex items-center gap-1">
                  <span className="font-mono text-warning">{scope}</span> ({n})
                  <Select
                    className="h-6 text-[11px]"
                    value=""
                    aria-label={`Route ${scope} to a project`}
                    onChange={(e) =>
                      e.target.value && saveRouting.mutate({ projectId: c.projectId, projectRoutes: { ...c.projectRoutes, [scope]: e.target.value } })
                    }
                  >
                    <option value="">Route to…</option>
                    {(projects.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </span>
              ))}
            </span>
          </Row>
        )}
        <Row label="Last sync">
          {relativeTime(c.lastSyncAt)} · polls every {Math.round(c.pollIntervalSec / 60)} min
        </Row>
        {c.lastError && (
          <Row label="Error">
            <span className="text-danger">{c.lastError}</span>
          </Row>
        )}
      </div>
      {editingRoutes && (
        <RoutingEditor
          className="mt-2"
          scopeLabel={scopeLabel}
          projects={projects.data ?? []}
          initial={{ projectId: c.projectId, projectRoutes: c.projectRoutes }}
          suggestions={unrouted.map(([scope]) => scope)}
          saving={saveRouting.isPending}
          onCancel={() => setEditingRoutes(false)}
          onSave={(r) => saveRouting.mutate(r)}
        />
      )}
      {!c.hasCredential && (
        <div className="mt-2 flex gap-2">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={source?.credential.label ?? "Token"} />
          <Button size="sm" onClick={() => saveToken.mutate()} disabled={!token}>
            Save token
          </Button>
        </div>
      )}
      {test.data && (
        <p className={`mt-2 flex items-center gap-1 ${test.data.ok ? "text-success" : "text-danger"}`}>
          {test.data.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />} {test.data.message}
        </p>
      )}
      {sync.data && (
        <p className="mt-2 text-fg-muted">
          Fetched {sync.data.fetched}: {sync.data.created} new, {sync.data.updated} updated, {sync.data.missing} out of scope
          {sync.data.unrouted > 0 && `, ${sync.data.unrouted} not routed to a project`}
        </p>
      )}
      {(sync.error || saveToken.error || saveRouting.error) && (
        <p className="mt-2 text-danger">{((sync.error ?? saveToken.error ?? saveRouting.error) as Error).message}</p>
      )}
    </div>
  )
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <>
    <span className="text-fg-subtle">{label}</span>
    <span className="min-w-0 break-words">{children}</span>
  </>
)

const defaultsOf = (s: SourceDescriptor) => Object.fromEntries(s.fields.map((f) => [f.key, f.default ?? ""]))

const NewConnection = ({ sources, onDone }: { sources: ReadonlyArray<SourceDescriptor>; onDone: () => void }) => {
  const projects = useQuery(q.projects())
  const qc = useQueryClient()
  const [provider, setProvider] = useState(sources[0]?.id ?? "")
  const source = sources.find((s) => s.id === provider)
  const [name, setName] = useState("")
  const [routing, setRouting] = useState<Routing>({ projectId: null, projectRoutes: {} })
  const [token, setToken] = useState("")
  const [pollMinutes, setPollMinutes] = useState(5)
  const [settings, setSettings] = useState<Record<string, string>>({})
  useEffect(() => {
    if (source) setSettings(defaultsOf(source))
  }, [source])

  const create = useMutation({
    mutationFn: () =>
      api.createSourceConnection({
        provider,
        name,
        projectId: routing.projectId,
        projectRoutes: cleanRoutes(routing.projectRoutes),
        token: token || undefined,
        pollIntervalSec: pollMinutes * 60,
        // Empty optional fields are omitted so the adapter's schema sees them as absent.
        settings: Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== ""))
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sourceConnections })
      onDone()
    }
  })
  const missingRequired = source?.fields.some((f) => f.required && !settings[f.key]) ?? true
  return (
    <form
      className="mb-3 space-y-2 rounded-md border bg-bg p-3"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
      data-testid="new-source-form"
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="Source" hint={source?.description}>
          <Select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="source-provider">
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Connection name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${source?.displayName ?? ""} work`} data-testid="source-name" />
        </Field>
      </div>
      {source?.fields.map((f) => (
        <SettingInput key={`${provider}-${f.key}`} field={f} value={settings[f.key] ?? ""} onChange={(v) => setSettings((s) => ({ ...s, [f.key]: v }))} />
      ))}
      {source && (
        <Field label={source.credential.label} hint={source.credential.hint}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} data-testid="source-token" />
        </Field>
      )}
      {source && (
        <RoutingFields scopeLabel={source.scopeLabel} projects={projects.data ?? []} value={routing} onChange={setRouting} />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Poll interval (minutes)">
          <Input type="number" min={1} value={pollMinutes} onChange={(e) => setPollMinutes(Math.max(1, Number(e.target.value)))} />
        </Field>
      </div>
      {create.error && <p className="text-xs text-danger">{(create.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name || missingRequired || (source?.credential.required && !token) || create.isPending} data-testid="source-create">
          {create.isPending && <Spinner />} Add connection
        </Button>
      </div>
    </form>
  )
}

const SettingInput = ({ field, value, onChange }: { field: SourceField; value: string; onChange: (v: string) => void }) => (
  <Field label={field.label} hint={field.hint}>
    {field.type === "select" ? (
      <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid={`source-field-${field.key}`}>
        {field.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    ) : field.type === "textarea" ? (
      <Textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className="font-mono" data-testid={`source-field-${field.key}`} />
    ) : (
      <Input
        type={field.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={field.type === "url" ? "font-mono" : undefined}
        data-testid={`source-field-${field.key}`}
      />
    )}
  </Field>
)

// ---- routing -----------------------------------------------------------------------------

interface Routing {
  readonly projectId: string | null
  readonly projectRoutes: Readonly<Record<string, string>>
}

/** Drops half-filled rows and normalizes keys the way the daemon does. */
const cleanRoutes = (routes: Readonly<Record<string, string>>) =>
  Object.fromEntries(
    Object.entries(routes)
      .map(([k, v]) => [k.trim().toUpperCase(), v] as const)
      .filter(([k, v]) => k !== "" && v !== "")
  )

/**
 * Remote project/team → AgentDesk project rows plus the fallback project. Rows are kept as an
 * array while editing so a key can be renamed (or be briefly empty) without losing its row.
 */
const RoutingFields = ({
  scopeLabel,
  projects,
  value,
  onChange,
  suggestions = []
}: {
  scopeLabel: string
  projects: ReadonlyArray<Project>
  value: Routing
  onChange: (r: Routing) => void
  suggestions?: ReadonlyArray<string>
}) => {
  const [rows, setRows] = useState<Array<{ scope: string; projectId: string }>>(() =>
    Object.entries(value.projectRoutes).map(([scope, projectId]) => ({ scope, projectId }))
  )
  const emit = (next: Array<{ scope: string; projectId: string }>) => {
    setRows(next)
    onChange({ ...value, projectRoutes: Object.fromEntries(next.map((r) => [r.scope, r.projectId])) })
  }
  const unused = suggestions.filter((s) => !rows.some((r) => r.scope.trim().toUpperCase() === s))
  return (
    <div className="space-y-2" data-testid="source-routing-editor">
      <Field
        label={`${scopeLabel} → AgentDesk project`}
        hint={`Each task goes to the project mapped to its ${scopeLabel} key (SEON for SEON-12). Already imported tasks stay where they are.`}
      >
        <div className="space-y-1">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                className="w-32 font-mono uppercase"
                value={r.scope}
                placeholder="KEY"
                aria-label={`${scopeLabel} key`}
                onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, scope: e.target.value } : x)))}
                data-testid="route-scope"
              />
              <span className="text-fg-subtle">→</span>
              <Select
                className="flex-1"
                value={r.projectId}
                aria-label="AgentDesk project"
                onChange={(e) => emit(rows.map((x, j) => (j === i ? { ...x, projectId: e.target.value } : x)))}
                data-testid="route-project"
              >
                <option value="">Choose project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <Button type="button" size="icon" variant="ghost" aria-label="Remove route" onClick={() => emit(rows.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => emit([...rows, { scope: "", projectId: "" }])} data-testid="add-route">
              <Plus /> Map a {scopeLabel}
            </Button>
            {unused.map((s) => (
              <Button key={s} type="button" size="sm" variant="ghost" className="font-mono" onClick={() => emit([...rows, { scope: s, projectId: "" }])}>
                <Plus /> {s}
              </Button>
            ))}
          </div>
        </div>
      </Field>
      <Field
        label="Fallback project"
        hint={
          value.projectId
            ? `Tasks from any unmapped ${scopeLabel} are imported here.`
            : `Tasks from an unmapped ${scopeLabel} are skipped and listed on the connection so you can route them later.`
        }
      >
        <Select value={value.projectId ?? ""} onChange={(e) => onChange({ ...value, projectId: e.target.value || null })} data-testid="source-default-project">
          <option value="">None (mapped projects only)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

const RoutingEditor = ({
  className,
  initial,
  saving,
  onSave,
  onCancel,
  ...rest
}: {
  className?: string
  scopeLabel: string
  projects: ReadonlyArray<Project>
  initial: Routing
  suggestions: ReadonlyArray<string>
  saving: boolean
  onSave: (r: Routing) => void
  onCancel: () => void
}) => {
  const [routing, setRouting] = useState<Routing>(initial)
  return (
    <form
      className={`space-y-2 rounded-md border bg-bg-muted/40 p-2 ${className ?? ""}`}
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ projectId: routing.projectId, projectRoutes: cleanRoutes(routing.projectRoutes) })
      }}
    >
      <RoutingFields {...rest} value={routing} onChange={setRouting} />
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving} data-testid="save-routing">
          {saving && <Spinner />} Save routing
        </Button>
      </div>
    </form>
  )
}
