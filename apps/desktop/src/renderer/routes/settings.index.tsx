import type { HarnessId } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { Bot, Monitor, Moon, Palette, Server, Sun } from "lucide-react"
import { HARNESS_LABELS } from "@/components/status"
import { Select } from "@/components/ui/input"
import { Spinner } from "@/components/ui/misc"
import { HARNESS_IDS, HarnessSettings } from "@/features/settings/harness-settings"
import { settingsSections } from "@/features/settings/registry"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useMutation, useQueryClient } from "@tanstack/react-query"

const SECTIONS = [
  { id: "harnesses", label: "Harnesses", icon: Bot },
  { id: "appearance", label: "Appearance", icon: Palette },
  ...settingsSections.map(({ id, label, icon }) => ({ id, label, icon })),
  { id: "daemon", label: "Daemon", icon: Server }
]

export const Route = createFileRoute("/settings/")({
  validateSearch: (s: Record<string, unknown>): { section?: string; harness?: HarnessId } => ({
    section: SECTIONS.some((x) => x.id === s.section) ? (s.section as string) : undefined,
    harness: HARNESS_IDS.includes(s.harness as HarnessId) ? (s.harness as HarnessId) : undefined
  }),
  component: SettingsPage
})

function SettingsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const settings = useQuery(q.harnessSettings())
  const section = search.section ?? "harnesses"
  const harness = search.harness ?? settings.data?.defaultHarness ?? "claude"
  const go = (next: { section?: string; harness?: HarnessId }) => void navigate({ search: (s) => ({ ...s, ...next }), replace: true })
  const current = SECTIONS.find((s) => s.id === section)!
  const Extra = settingsSections.find((s) => s.id === section)?.component
  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b px-4">
        <h1 className="flex h-11 items-center text-[13px] font-semibold">Settings</h1>
        <nav role="tablist" aria-label="Settings sections" className="-mb-px flex gap-1 overflow-x-auto">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={section === s.id}
              onClick={() => go({ section: s.id })}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 pb-2 pt-1 text-[13px] text-fg-muted hover:text-fg",
                section === s.id && "border-accent text-fg"
              )}
              data-testid={`settings-nav-${s.id}`}
            >
              <s.icon className="size-3.5 shrink-0" />
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <div role="tabpanel" aria-label={current.label} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {section === "harnesses" && (
            <>
              <DefaultHarness />
              <HarnessSettings harness={harness} onHarness={(h) => go({ harness: h })} />
            </>
          )}
          {section === "appearance" && <AppearanceSettings />}
          {section === "daemon" && <DaemonSettings />}
          {Extra && <Extra />}
        </div>
      </div>
    </div>
  )
}

const DefaultHarness = () => {
  const settings = useQuery(q.harnessSettings())
  const qc = useQueryClient()
  const saveDefault = useMutation({
    mutationFn: (defaultHarness: HarnessId) => api.updateHarnessSettings({ defaultHarness }),
    onSuccess: (value) => qc.setQueryData(qk.harnessSettings, value)
  })
  return (
    <section className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-bg-subtle px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">Default harness for new projects</p>
        <p className="text-[11px] text-fg-subtle">Existing projects keep theirs. Tickets can override model, effort and permissions.</p>
      </div>
      {settings.data ? (
        <Select aria-label="Default harness for new projects" value={settings.data.defaultHarness} disabled={saveDefault.isPending} onChange={(e) => saveDefault.mutate(e.target.value as HarnessId)} className="h-8 w-44" data-testid="default-harness">
          {HARNESS_IDS.map((id) => <option key={id} value={id}>{HARNESS_LABELS[id]}</option>)}
        </Select>
      ) : <Spinner />}
      {saveDefault.error && <p role="alert" className="w-full text-xs text-danger">{saveDefault.error.message}</p>}
    </section>
  )
}

const AppearanceSettings = () => {
  const theme = useUi((s) => s.theme)
  const setTheme = useUi((s) => s.setTheme)
  return (
    <section className="rounded-lg border bg-bg-subtle p-4">
      <p className="text-[13px] font-medium">Theme</p>
      <p className="mb-3 text-[11px] text-fg-subtle">System follows your OS appearance.</p>
      <div role="radiogroup" aria-label="Theme" className="grid max-w-md grid-cols-3 gap-2">
        {([["dark", "Dark", Moon], ["light", "Light", Sun], ["system", "System", Monitor]] as const).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            onClick={() => setTheme(value)}
            className={cn(
              "flex flex-col items-center gap-1.5 rounded-md border px-3 py-3 text-xs text-fg-muted hover:bg-bg-muted/50",
              theme === value && "border-accent/60 bg-accent/5 text-fg"
            )}
            data-testid={`theme-${value}`}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
    </section>
  )
}

const DaemonSettings = () => {
  const info = useQuery(q.info())
  if (!info.data) return <Spinner />
  const rows: Array<[string, React.ReactNode]> = [
    ["Version", info.data.version],
    ["Process", `pid ${info.data.pid}`],
    ["Data directory", <span key="dataDir" className="font-mono">{info.data.dataDir}</span>],
    ["Active sessions", info.data.activeSessions],
    ["Active runs", info.data.activeRuns]
  ]
  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-bg-subtle p-4">
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-2 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-subtle">{k}</dt>
              <dd className="min-w-0 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={cn("rounded-lg border p-4 text-xs", info.data.persistent ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5")}>
        <p className={info.data.persistent ? "text-success" : "text-warning"}>
          {info.data.persistent
            ? "Supervised service: survives the app quitting and restarts on login."
            : "Background process: keeps working when the window closes, but ends if killed, on logout or reboot."}
        </p>
        {!info.data.persistent && (
          <p className="mt-2 text-fg-muted">
            Install it as a macOS login service with <code className="font-mono">pnpm --filter @agentdesk/daemon install-service</code>.
          </p>
        )}
      </section>
    </div>
  )
}
