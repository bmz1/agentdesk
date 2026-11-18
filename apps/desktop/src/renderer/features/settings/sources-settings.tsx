import type { SourceConnection, SourceDescriptor, SourceField } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Section, Spinner } from "@/components/ui/misc"
import { UNASSIGNED } from "@/features/board/issues-view"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { relativeTime } from "@/lib/utils"

/**
 * Generic settings for every task source (Jira, Linear, …). Forms are rendered
 * from each source's descriptor, so adding a source needs no UI changes.
 * Connections are global: imported tickets wait unassigned until someone puts
 * them in a project.
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
        AgentDesk imports tasks from {(sources.data ?? []).map((s) => s.displayName).join(", ") || "external trackers"}. A
        connection is not tied to a project: imported tickets wait in{" "}
        <Link to="/issues" search={{ project: UNASSIGNED }} className="text-accent hover:underline">
          Unassigned
        </Link>{" "}
        until you assign each one to a project. It never creates, edits, comments on or transitions remote tasks; moving a card changes the local board
        only. Tokens are stored in the OS credential store, never in the database.
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
        <Row label="Last sync">
          {relativeTime(c.lastSyncAt)} · polls every {Math.round(c.pollIntervalSec / 60)} min
        </Row>
        {c.lastError && (
          <Row label="Error">
            <span className="text-danger">{c.lastError}</span>
          </Row>
        )}
      </div>
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
        </p>
      )}
      {(sync.error || saveToken.error) && <p className="mt-2 text-danger">{((sync.error ?? saveToken.error) as Error).message}</p>}
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
  const qc = useQueryClient()
  const [provider, setProvider] = useState(sources[0]?.id ?? "")
  const source = sources.find((s) => s.id === provider)
  const [name, setName] = useState("")
  const [token, setToken] = useState("")
  const [pollMinutes, setPollMinutes] = useState(5)
  const [settings, setSettings] = useState<Record<string, string>>(() => (source ? defaultsOf(source) : {}))
  // Each provider has its own fields: switching starts from that provider's defaults.
  const pickProvider = (id: string) => {
    const next = sources.find((s) => s.id === id)
    setProvider(id)
    setSettings(next ? defaultsOf(next) : {})
  }

  const create = useMutation({
    mutationFn: () =>
      api.createSourceConnection({
        provider,
        name,
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
          <Select value={provider} onChange={(e) => pickProvider(e.target.value)} data-testid="source-provider">
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
