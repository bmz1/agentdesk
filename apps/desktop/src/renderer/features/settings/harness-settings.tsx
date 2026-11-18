import type { HarnessDefaults, HarnessDetection, HarnessId, HarnessSettings as Settings } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { HARNESS_LABELS } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Section, Spinner } from "@/components/ui/misc"
import { modeCaveat, PERMISSION_MODES } from "@/features/projects/project-form"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"

export const HarnessSettings = () => {
  const harnesses = useQuery(q.harnesses())
  const settings = useQuery(q.harnessSettings())
  const qc = useQueryClient()
  const refresh = useMutation({ mutationFn: () => api.harnesses(true), onSuccess: (value) => qc.setQueryData(qk.harnesses, value) })
  const saveDefault = useMutation({ mutationFn: (defaultHarness: HarnessId) => api.updateHarnessSettings({ defaultHarness }), onSuccess: (value) => qc.setQueryData(qk.harnessSettings, value) })
  return (
    <Section title="Agent harness defaults" actions={<Button size="sm" variant="ghost" disabled={refresh.isPending} onClick={() => refresh.mutate()}><RefreshCw className={refresh.isPending ? "animate-spin" : ""} />Re-detect</Button>}>
      {settings.isPending ? <Spinner /> : settings.error ? <p role="alert" className="text-xs text-danger">{settings.error.message}</p> : settings.data && <div className="space-y-4">
        <Field label="Default harness for new projects" hint="Existing projects keep their selected harness. Each project can override permissions, and each ticket can override its model.">
          <Select aria-label="Default harness for new projects" value={settings.data.defaultHarness} disabled={saveDefault.isPending} onChange={(e) => saveDefault.mutate(e.target.value as HarnessId)} data-testid="default-harness">
            {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((id) => <option key={id} value={id}>{HARNESS_LABELS[id]}</option>)}
          </Select>
        </Field>
        <p className="text-xs text-fg-muted">Saved defaults apply when launching or resuming an agent, including workflow steps. Running agents keep their current configuration.</p>
        {saveDefault.error && <p role="alert" className="text-xs text-danger">{saveDefault.error.message}</p>}
        {(Object.keys(HARNESS_LABELS) as Array<HarnessId>).map((id) => <HarnessProfile key={id} id={id} profile={settings.data!.harnesses[id]} detection={harnesses.data?.find((h) => h.id === id)} />)}
      </div>}
      {(harnesses.error || refresh.error) && <p role="alert" className="mt-2 text-xs text-danger">{(harnesses.error ?? refresh.error)?.message}</p>}
      <p className="mt-3 text-[11px] text-fg-subtle">Harnesses use their own supported login. AgentDesk does not store subscription credentials or edit the harness CLI’s own configuration files.</p>
    </Section>
  )
}

const HarnessProfile = ({ id, profile, detection }: { id: HarnessId; profile: Settings["harnesses"][HarnessId]; detection?: HarnessDetection }) => {
  const qc = useQueryClient()
  const listId = useId()
  const [draft, setDraft] = useState<HarnessDefaults>(profile)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setDraft(profile) }, [profile, dirty])
  const update = (value: Partial<HarnessDefaults>) => { setDraft((p) => ({ ...p, ...value })); setDirty(true) }
  const save = useMutation({
    mutationFn: () => api.updateHarnessSettings({ harnesses: { [id]: draft } }),
    onSuccess: (value) => { qc.setQueryData(qk.harnessSettings, value); setDraft(value.harnesses[id]); setDirty(false) }
  })
  const mode = PERMISSION_MODES.find((m) => m.id === draft.permissionMode)
  return (
    <details className="rounded-md border bg-bg" data-testid={`harness-${id}`}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 p-3 text-xs">
        {detection?.installed ? <CheckCircle2 className="size-3.5 text-success" /> : <XCircle className="size-3.5 text-fg-subtle" />}
        <span className="font-medium">{HARNESS_LABELS[id]}</span>
        <span className="text-fg-subtle">{detection ? detection.installed ? detection.version : "Not installed" : "Detecting…"}</span>
        <span className="ml-auto min-w-0 max-w-full truncate text-fg-muted">{profile.model ?? "Harness model default"} · {PERMISSION_MODES.find((m) => m.id === profile.permissionMode)?.label}</span>
        <span className="shrink-0 text-accent">Configure</span>
      </summary>
      <form className="space-y-3 border-t p-3" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        <fieldset disabled={save.isPending} className="space-y-3 disabled:opacity-60">
          <Field label="Default model" hint={id === "opencode" ? "Choose or enter provider/model. Leave empty to use OpenCode’s default." : "Choose an available model or enter a model ID. Leave empty to use the harness’s default."}>
            <Input aria-label={`${HARNESS_LABELS[id]} default model`} value={draft.model ?? ""} onChange={(e) => update({ model: e.target.value || null })} list={listId} maxLength={500} placeholder="Harness default" data-testid={`harness-model-${id}`} />
            <datalist id={listId}>{(detection?.models ?? []).map((m) => <option key={m.id} value={m.id}>{m.provider ? `${m.provider} · ` : ""}{m.label}</option>)}</datalist>
          </Field>
          <Field label="Default permissions" hint={[mode?.hint, modeCaveat(draft.permissionMode, detection?.capabilities)].filter(Boolean).join(" ")}>
            <Select aria-label={`${HARNESS_LABELS[id]} default permissions`} value={draft.permissionMode} onChange={(e) => update({ permissionMode: e.target.value as HarnessDefaults["permissionMode"] })} data-testid={`harness-permissions-${id}`}>
              {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </Select>
          </Field>
          <Field label="Extra instructions" hint="Appended to the harness’s system instructions for new and resumed sessions.">
            <Textarea aria-label={`${HARNESS_LABELS[id]} extra instructions`} rows={3} maxLength={20_000} value={draft.instructions} onChange={(e) => update({ instructions: e.target.value })} placeholder="Project-independent coding preferences…" data-testid={`harness-instructions-${id}`} />
          </Field>
        </fieldset>
        {save.error && <p role="alert" className="text-xs text-danger">{save.error.message}</p>}
        {save.isSuccess && !dirty && <p role="status" className="text-xs text-success">Defaults saved.</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={save.isPending || !dirty} onClick={() => { setDraft(profile); setDirty(false) }}>Discard changes</Button>
          <Button type="submit" size="sm" disabled={save.isPending || !dirty} data-testid={`harness-defaults-save-${id}`}>{save.isPending && <Spinner />}Save defaults</Button>
        </div>
      </form>
    </details>
  )
}
