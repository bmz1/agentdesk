import { Download, RefreshCw } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/misc"
import { bridge } from "@/lib/connection"
import { RELEASES_URL, updateSummary, useUpdateState } from "@/lib/updates"
import { cn } from "@/lib/utils"

export const UpdateSettings = () => {
  const state = useUpdateState()
  const [installing, setInstalling] = useState(false)
  const updates = bridge()?.updates
  if (!updates) {
    return <p className="text-xs text-fg-muted">Updates are managed by the AgentDesk desktop app.</p>
  }
  if (!state) return <Spinner />
  const busy = state.status === "checking" || state.status === "downloading"
  const install = async () => {
    setInstalling(true)
    // Resolves false if the user kept running work; on success the app quits.
    if (!(await updates.install())) setInstalling(false)
  }
  return (
    <section className="space-y-3 rounded-lg border bg-bg-subtle p-4" data-testid="update-settings">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">AgentDesk {state.currentVersion}</p>
          <p className={cn("text-[11px]", state.status === "error" ? "text-danger" : "text-fg-subtle")} role="status">
            {updateSummary(state)}
          </p>
        </div>
        {state.status === "ready" ? (
          <Button onClick={() => void install()} disabled={installing} data-testid="update-install">
            <Download />
            Restart and update
          </Button>
        ) : state.status !== "unsupported" ? (
          <Button variant="secondary" onClick={() => void updates.check()} disabled={busy} data-testid="update-check">
            {busy ? <Spinner /> : <RefreshCw />}
            Check for updates
          </Button>
        ) : null}
      </div>
      {state.status === "ready" && (
        <p className="text-[11px] text-fg-muted">
          Installing restarts the app and the background daemon it started; running agent work is interrupted.
        </p>
      )}
      {(state.status === "error" || state.status === "unsupported") && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => void bridge()?.openExternal(RELEASES_URL)}>
          Download the latest release from GitHub
        </Button>
      )}
    </section>
  )
}
