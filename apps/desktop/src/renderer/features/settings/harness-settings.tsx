import type { HarnessCapabilities, HarnessDefaults, HarnessDetection, HarnessId, HarnessModel, PermissionMode } from "@agentdesk/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, CircleDashed, RefreshCw, XCircle } from "lucide-react"
import { useState } from "react"
import { HARNESS_LABELS } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, Input, Select, Textarea } from "@/components/ui/input"
import { Spinner } from "@/components/ui/misc"
import { modeCaveat, PERMISSION_MODES } from "@/features/projects/project-form"
import { modelLabel } from "@/features/session/model-picker"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { cn } from "@/lib/utils"

export const HARNESS_IDS = Object.keys(HARNESS_LABELS) as Array<HarnessId>

const CUSTOM = "__custom__"

/**
 * A model chosen from what the harness lists (grouped by provider for OpenCode), or any model id typed
 * in. Harnesses that list nothing get the text field only.
 */
export const ModelSelect = ({
  id,
  value,
  models,
  defaultLabel,
  onChange
}: {
  id: HarnessId
  value: string | null
  models: ReadonlyArray<HarnessModel>
  defaultLabel?: string
  onChange: (model: string | null) => void
}) => {
  const listed = !value || models.some((m) => m.id === value)
  // A value the harness doesn't list can only be shown in the free-text field.
  const [customPicked, setCustom] = useState(false)
  const custom = customPicked || !listed
  const input = (
    <Input
      aria-label={`${HARNESS_LABELS[id]} default model`}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      maxLength={500}
      placeholder={id === "opencode" ? "provider/model" : "Model ID"}
      className="h-8 font-mono"
      data-testid={models.length ? `harness-model-custom-${id}` : `harness-model-${id}`}
    />
  )
  if (models.length === 0) return input
  const providers = [...new Set(models.map((m) => m.provider).filter(Boolean))] as Array<string>
  const option = (m: HarnessModel) => <option key={m.id} value={m.id}>{providers.length ? m.label : modelLabel(m)}{m.id !== m.label && !providers.length ? ` · ${m.id}` : ""}</option>
  return (
    <div className="space-y-2">
      <Select
        aria-label={`${HARNESS_LABELS[id]} default model`}
        value={custom ? CUSTOM : value ?? ""}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setCustom(true)
          setCustom(false)
          onChange(e.target.value || null)
        }}
        className="h-8 w-full"
        data-testid={`harness-model-${id}`}
      >
        <option value="">{defaultLabel ? `Harness default · ${defaultLabel}` : "Harness default"}</option>
        {providers.length
          ? providers.map((p) => <optgroup key={p} label={p}>{models.filter((m) => m.provider === p).map(option)}</optgroup>)
          : models.map(option)}
        <option value={CUSTOM}>Other model ID…</option>
      </Select>
      {custom && input}
    </div>
  )
}

const capabilityRows = (c: HarnessCapabilities) => [
  { label: "Plan mode", value: c.planMode === "native" ? "Native" : "Read-only sandbox" },
  { label: "Accept edits", value: c.acceptEdits === "native" ? "Native" : "Approved by AgentDesk" },
  { label: "Effort changes", value: c.liveEffort ? "Apply live" : "Restart the agent" },
  { label: "Allow for session", value: c.allowForSession ? "Supported" : "Not supported" },
  { label: "Agent questions", value: c.questions ? "Supported" : "Not supported" },
  { label: "Usage", value: c.cost ? "Tokens and cost" : "Tokens only" },
  { label: "Rate limits", value: c.rateLimits ? "Reported" : "Not reported" }
]

export const HarnessStatus = ({ detection }: { detection?: HarnessDetection }) =>
  !detection ? (
    <Badge tone="outline"><CircleDashed className="size-3" />Detecting…</Badge>
  ) : detection.installed ? (
    <Badge tone="success"><CheckCircle2 className="size-3" />Installed{detection.version ? ` · ${detection.version}` : ""}</Badge>
  ) : (
    <Badge tone="neutral"><XCircle className="size-3" />Not installed</Badge>
  )

/** One harness: what was detected, what it supports, and the defaults its agents launch with. */
export const HarnessPanel = ({ id }: { id: HarnessId }) => {
  const qc = useQueryClient()
  const harnesses = useQuery(q.harnesses())
  const settings = useQuery(q.harnessSettings())
  const detection = harnesses.data?.find((h) => h.id === id)
  const profile = settings.data?.harnesses[id]
  const isDefault = settings.data?.defaultHarness === id
  // Unsaved edits; until there are any the form shows the stored profile as it refreshes.
  const [edits, setEdits] = useState<HarnessDefaults | null>(null)
  const draft = edits ?? profile
  const dirty = edits !== null
  const update = (value: Partial<HarnessDefaults>) => setEdits((p) => {
    const base = p ?? profile
    return base ? { ...base, ...value } : null
  })
  const save = useMutation({
    mutationFn: () => api.updateHarnessSettings({ harnesses: { [id]: draft! } }),
    onSuccess: (value) => { qc.setQueryData(qk.harnessSettings, value); setEdits(null) }
  })
  const makeDefault = useMutation({
    mutationFn: () => api.updateHarnessSettings({ defaultHarness: id }),
    onSuccess: (value) => qc.setQueryData(qk.harnessSettings, value)
  })
  if (settings.error) return <p role="alert" className="text-xs text-danger">{settings.error.message}</p>
  if (!draft) return <Spinner />
  return (
    <div className="space-y-5" data-testid={`harness-${id}`}>
      <section className="rounded-lg border bg-bg-subtle p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">{HARNESS_LABELS[id]}</h3>
          <HarnessStatus detection={detection} />
          {isDefault ? (
            <Badge tone="accent">Default for new projects</Badge>
          ) : (
            <Button size="sm" variant="ghost" className="ml-auto" disabled={makeDefault.isPending} onClick={() => makeDefault.mutate()}>Make default</Button>
          )}
        </div>
        {detection?.detail && <p className="mt-2 text-xs text-fg-muted">{detection.detail}</p>}
        {detection?.binary && <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle" title={detection.binary}>{detection.binary}</p>}
        {detection?.capabilities && (
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 border-t pt-3 text-xs sm:grid-cols-3">
            {capabilityRows(detection.capabilities).map((r) => (
              <div key={r.label} className="min-w-0">
                <dt className="text-[11px] text-fg-subtle">{r.label}</dt>
                <dd className="truncate">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {makeDefault.error && <p role="alert" className="mt-2 text-xs text-danger">{makeDefault.error.message}</p>}
      </section>

      <form className="rounded-lg border bg-bg-subtle" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
        <header className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Launch defaults</h3>
          <p className="mt-0.5 text-xs text-fg-muted">Apply when an agent starts or resumes, including workflow steps. Projects and tickets can override them; running agents keep theirs.</p>
        </header>
        <fieldset disabled={save.isPending} className="space-y-5 p-4 disabled:opacity-60">
          <Field label="Model">
            <ModelSelect id={id} value={draft.model} models={detection?.models ?? []} defaultLabel={detection?.defaultModel} onChange={(model) => update({ model })} />
          </Field>
          <PermissionCards id={id} value={draft.permissionMode} capabilities={detection?.capabilities} onChange={(permissionMode) => update({ permissionMode })} />
          <Field label="Extra instructions" hint="Appended to the harness’s system instructions for new and resumed sessions.">
            <Textarea aria-label={`${HARNESS_LABELS[id]} extra instructions`} rows={4} maxLength={20_000} value={draft.instructions} onChange={(e) => update({ instructions: e.target.value })} placeholder="Project-independent coding preferences…" className="resize-y px-3 py-2" data-testid={`harness-instructions-${id}`} />
          </Field>
        </fieldset>
        <footer className="flex items-center justify-end gap-2 rounded-b-lg border-t bg-bg/40 px-4 py-2.5">
          {save.error && <p role="alert" className="mr-auto text-xs text-danger">{save.error.message}</p>}
          {save.isSuccess && !dirty && <p role="status" className="mr-auto text-xs text-success">Defaults saved.</p>}
          {dirty && !save.error && <p className="mr-auto text-xs text-fg-subtle">Unsaved changes</p>}
          <Button type="button" variant="ghost" size="sm" disabled={save.isPending || !dirty} onClick={() => setEdits(null)}>Discard</Button>
          <Button type="submit" size="sm" disabled={save.isPending || !dirty} data-testid={`harness-defaults-save-${id}`}>{save.isPending && <Spinner />}Save defaults</Button>
        </footer>
      </form>
    </div>
  )
}

const PermissionCards = ({
  id,
  value,
  capabilities,
  onChange
}: {
  id: HarnessId
  value: PermissionMode
  capabilities?: HarnessCapabilities
  onChange: (mode: PermissionMode) => void
}) => (
  <fieldset className="space-y-1.5">
    <legend className="mb-1.5 text-xs font-medium text-fg-muted">Permissions</legend>
    <div role="radiogroup" aria-label={`${HARNESS_LABELS[id]} default permissions`} className="grid gap-1.5" data-testid={`harness-permissions-${id}`}>
      {PERMISSION_MODES.map((m) => {
        const caveat = modeCaveat(m.id, capabilities)
        const selected = value === m.id
        return (
          <label
            key={m.id}
            className={cn(
              "flex cursor-pointer gap-3 rounded-md border px-3 py-2 transition-colors hover:bg-bg-muted/50",
              selected && "border-accent/60 bg-accent/5",
              m.id === "unrestricted" && selected && "border-warning/60 bg-warning/5"
            )}
          >
            <input type="radio" name={`permissions-${id}`} value={m.id} checked={selected} onChange={() => onChange(m.id)} className="mt-0.5 accent-accent" />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{m.label}</span>
              <span className="block text-[11px] text-fg-subtle">{m.hint}</span>
              {caveat && <span className="mt-0.5 block text-[11px] text-warning">{caveat}</span>}
            </span>
          </label>
        )
      })}
    </div>
  </fieldset>
)

/** Harness tabs: one view per harness, with re-detection for all of them. */
export const HarnessSettings = ({ harness, onHarness }: { harness: HarnessId; onHarness: (id: HarnessId) => void }) => {
  const harnesses = useQuery(q.harnesses())
  const settings = useQuery(q.harnessSettings())
  const qc = useQueryClient()
  const refresh = useMutation({ mutationFn: () => api.harnesses(true), onSuccess: (value) => qc.setQueryData(qk.harnesses, value) })
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 border-b">
        <div role="tablist" aria-label="Harness" className="-mb-px flex min-w-0 gap-1 overflow-x-auto">
          {HARNESS_IDS.map((id) => {
            const d = harnesses.data?.find((h) => h.id === id)
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={harness === id}
                onClick={() => onHarness(id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 text-[13px] text-fg-muted hover:text-fg",
                  harness === id && "border-accent text-fg"
                )}
                data-testid={`harness-tab-${id}`}
              >
                <span className={cn("size-1.5 rounded-full", !d ? "bg-fg-subtle" : d.installed ? "bg-success" : "bg-fg-subtle/50")} />
                {HARNESS_LABELS[id]}
                {settings.data?.defaultHarness === id && <span className="text-[10px] text-fg-subtle">default</span>}
              </button>
            )
          })}
        </div>
        <Button size="sm" variant="ghost" className="ml-auto shrink-0" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />Re-detect
        </Button>
      </div>
      {(harnesses.error || refresh.error) && <p role="alert" className="text-xs text-danger">{(harnesses.error ?? refresh.error)?.message}</p>}
      <div role="tabpanel">
        <HarnessPanel key={harness} id={harness} />
      </div>
      <p className="text-[11px] text-fg-subtle">Harnesses use their own login. AgentDesk does not store subscription credentials or edit the harness CLI’s own configuration files.</p>
    </div>
  )
}
