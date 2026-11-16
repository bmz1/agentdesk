import { useQuery } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Section } from "@/components/ui/misc"
import { Select } from "@/components/ui/input"
import { HarnessSettings } from "@/features/settings/harness-settings"
import { settingsSections } from "@/features/settings/registry"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"

export const Route = createFileRoute("/settings/")({
  component: SettingsPage
})

function SettingsPage() {
  const info = useQuery(q.info())
  const theme = useUi((s) => s.theme)
  const setTheme = useUi((s) => s.setTheme)
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          <HarnessSettings />
          {settingsSections.map((S, i) => (
            <S key={i} />
          ))}
          <Section title="Daemon">
            {info.data && (
              <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-xs">
                <dt className="text-fg-subtle">Version</dt>
                <dd>{info.data.version}</dd>
                <dt className="text-fg-subtle">Process</dt>
                <dd>pid {info.data.pid}</dd>
                <dt className="text-fg-subtle">Data directory</dt>
                <dd className="font-mono">{info.data.dataDir}</dd>
                <dt className="text-fg-subtle">Active sessions</dt>
                <dd>{info.data.activeSessions}</dd>
                <dt className="text-fg-subtle">Active runs</dt>
                <dd>{info.data.activeRuns}</dd>
                <dt className="text-fg-subtle">Persistence</dt>
                <dd className={info.data.persistent ? "text-success" : "text-warning"}>
                  {info.data.persistent
                    ? "Supervised service — survives the app quitting and restarts on login"
                    : "Background process — keeps working when the window closes, but ends if killed, on logout or reboot"}
                </dd>
              </dl>
            )}
            {!info.data?.persistent && (
              <p className="mt-3 text-[11px] text-fg-subtle">
                To install as a macOS login service run <code className="font-mono">pnpm --filter @agentdesk/daemon install-service</code>.
              </p>
            )}
          </Section>
          <Section title="Appearance">
            <div className="flex items-center gap-3 text-xs">
              <span className="w-28 text-fg-muted">Theme</span>
              <Select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">System</option>
              </Select>
            </div>
          </Section>
        </div>
      </div>
    </div>
  )
}
