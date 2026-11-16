import type { JiraConnection } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, Input, Select } from "@/components/ui/input"
import { Section, Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { relativeTime } from "@/lib/utils"

export const JiraSettings = () => {
  const connections = useQuery(q.jira())
  const [adding, setAdding] = useState(false)
  return (
    <Section
      title="Jira (read-only sync)"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setAdding(!adding)}>
          <Plus /> Add connection
        </Button>
      }
    >
      <p className="mb-3 text-[11px] text-fg-subtle">
        AgentDesk only reads issues matching your JQL. It never creates, edits, comments on or transitions Jira issues; moving
        a card changes the local board only. Tokens are stored in the OS credential store, never in the database.
      </p>
      {adding && <NewConnection onDone={() => setAdding(false)} />}
      {connections.isLoading ? (
        <Spinner />
      ) : (
        <div className="space-y-2">
          {(connections.data ?? []).map((c) => (
            <ConnectionRow key={c.id} c={c} />
          ))}
          {connections.data?.length === 0 && !adding && <p className="text-xs text-fg-muted">No Jira connections.</p>}
        </div>
      )}
    </Section>
  )
}

const ConnectionRow = ({ c }: { c: JiraConnection }) => {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.jira })
  const sync = useMutation({ mutationFn: (full: boolean) => api.syncJira(c.id, full), onSettled: invalidate })
  const test = useMutation({ mutationFn: () => api.testJira(c.id) })
  const toggle = useMutation({ mutationFn: () => api.updateJiraConnection(c.id, { enabled: !c.enabled }), onSettled: invalidate })
  const del = useMutation({ mutationFn: () => api.deleteJiraConnection(c.id), onSettled: invalidate })
  const [token, setToken] = useState("")
  const saveToken = useMutation({
    mutationFn: () => api.updateJiraConnection(c.id, { token }),
    onSuccess: () => setToken(""),
    onSettled: invalidate
  })
  const projects = useQuery(q.projects())
  return (
    <div className="rounded-md border bg-bg p-3 text-xs" data-testid="jira-connection">
      <div className="flex items-center gap-2">
        <span className="font-medium">{c.name}</span>
        <Badge tone="outline">{c.deployment === "cloud" ? "Cloud" : "Data Center"}</Badge>
        {!c.enabled && <Badge tone="neutral">paused</Badge>}
        {c.lastError ? <Badge tone="danger">error</Badge> : c.lastSyncAt ? <Badge tone="success">ok</Badge> : null}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => test.mutate()} disabled={test.isPending}>
          Test
        </Button>
        <Button size="sm" variant="secondary" onClick={() => sync.mutate(false)} disabled={sync.isPending}>
          {sync.isPending ? <Spinner /> : <RefreshCw />} Sync
        </Button>
        <Button size="sm" variant="ghost" onClick={() => sync.mutate(true)} disabled={sync.isPending} title="Full sync detects issues that left the JQL scope">
          Full
        </Button>
        <Button size="sm" variant="ghost" onClick={() => toggle.mutate()}>
          {c.enabled ? "Pause" : "Resume"}
        </Button>
        <Button size="icon" variant="ghost" onClick={() => confirm("Remove connection? Imported tickets are kept.") && del.mutate()}>
          <Trash2 />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-[90px_1fr] gap-y-1 text-fg-muted">
        <span className="text-fg-subtle">Site</span>
        <span className="font-mono">{c.baseUrl}</span>
        <span className="text-fg-subtle">JQL</span>
        <span className="font-mono">{c.jql}</span>
        <span className="text-fg-subtle">Project</span>
        <span>{projects.data?.find((p) => p.id === c.projectId)?.name}</span>
        <span className="text-fg-subtle">Last sync</span>
        <span>
          {relativeTime(c.lastSyncAt)} · polls every {Math.round(c.pollIntervalSec / 60)} min
        </span>
        {c.lastError && (
          <>
            <span className="text-fg-subtle">Error</span>
            <span className="text-danger">{c.lastError}</span>
          </>
        )}
      </div>
      {!c.hasCredential && (
        <div className="mt-2 flex gap-2">
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="API token / PAT" />
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

const NewConnection = ({ onDone }: { onDone: () => void }) => {
  const projects = useQuery(q.projects())
  const qc = useQueryClient()
  const [form, setForm] = useState({
    name: "",
    deployment: "cloud" as "cloud" | "datacenter",
    baseUrl: "",
    principal: "",
    token: "",
    jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    projectId: "",
    pollIntervalSec: 300
  })
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const create = useMutation({
    mutationFn: () => api.createJiraConnection({ ...form, projectId: form.projectId || projects.data?.[0]?.id || "" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.jira })
      onDone()
    }
  })
  return (
    <form
      className="mb-3 space-y-2 rounded-md border bg-bg p-3"
      onSubmit={(e) => {
        e.preventDefault()
        create.mutate()
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="SEON Jira" />
        </Field>
        <Field label="Deployment" hint="Confirm whether your org uses Cloud or Data Center.">
          <Select value={form.deployment} onChange={(e) => set("deployment", e.target.value as "cloud" | "datacenter")}>
            <option value="cloud">Jira Cloud (email + API token)</option>
            <option value="datacenter">Data Center (personal access token)</option>
          </Select>
        </Field>
      </div>
      <Field label="Site URL">
        <Input value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://your-org.atlassian.net" className="font-mono" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={form.deployment === "cloud" ? "Account email" : "Username (optional)"}>
          <Input value={form.principal} onChange={(e) => set("principal", e.target.value)} />
        </Field>
        <Field label={form.deployment === "cloud" ? "API token" : "Personal access token"}>
          <Input type="password" value={form.token} onChange={(e) => set("token", e.target.value)} />
        </Field>
      </div>
      <Field label="JQL scope" hint="Only issues matching this query are imported. Keep it narrow.">
        <Input value={form.jql} onChange={(e) => set("jql", e.target.value)} className="font-mono" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Import into project">
          <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Poll interval (minutes)">
          <Input
            type="number"
            min={1}
            value={Math.round(form.pollIntervalSec / 60)}
            onChange={(e) => set("pollIntervalSec", Math.max(1, Number(e.target.value)) * 60)}
          />
        </Field>
      </div>
      {create.error && <p className="text-xs text-danger">{(create.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!form.name || !form.baseUrl || !form.jql || create.isPending}>
          {create.isPending && <Spinner />} Add connection
        </Button>
      </div>
    </form>
  )
}
