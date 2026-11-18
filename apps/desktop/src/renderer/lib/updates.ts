import { useEffect, useState } from "react"
import type { UpdateState } from "../../main/updater"
import { bridge } from "./connection"

export type { UpdateState }

export const RELEASES_URL = "https://github.com/bmz1/agentdesk/releases/latest"

/** Live updater state from the main process; undefined outside the desktop app. */
export const useUpdateState = (): UpdateState | undefined => {
  const updates = bridge()?.updates
  const [state, setState] = useState<UpdateState>()
  useEffect(() => {
    if (!updates) return
    let live = true
    const unsubscribe = updates.subscribe(setState)
    void updates.getState().then((s) => live && setState((current) => current ?? s))
    return () => {
      live = false
      unsubscribe()
    }
  }, [updates])
  return state
}

export const updateSummary = (state: UpdateState): string => {
  switch (state.status) {
    case "unsupported":
      return state.message ?? "Automatic updates are unavailable."
    case "checking":
      return "Checking for updates…"
    case "downloading":
      return `Downloading ${state.availableVersion}${state.percent ? ` (${state.percent}%)` : ""}…`
    case "ready":
      return `Version ${state.availableVersion} is ready to install.`
    case "error":
      return `Couldn't update: ${state.message ?? "unknown error"}`
    case "idle":
      return state.checkedAt ? "AgentDesk is up to date." : "Updates are checked automatically."
  }
}
