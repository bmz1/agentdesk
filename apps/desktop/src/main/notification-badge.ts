import type { AgentSession, Approval } from "@agentdesk/contracts"
import { notificationCount } from "../renderer/lib/agent-state"

interface Options {
  connection: () => { url: string; token: string } | undefined
  setBadge: (count: number) => void
  fetch?: typeof fetch
}

/** Lives in Electron's main process so the Dock still updates after closing the window. */
export const createNotificationBadge = (options: Options) => {
  let seen: Record<string, number> = {}
  let lastCount = -1
  let polling = false
  let stopped = false
  const apply = (count: number) => {
    if (!stopped && count !== lastCount) { lastCount = count; options.setBadge(count) }
  }
  const refresh = async () => {
    if (polling || stopped) return
    const connection = options.connection()
    if (!connection) return
    polling = true
    try {
      const get = async (path: string) => {
        const res = await (options.fetch ?? fetch)(connection.url + path, {
          headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(4000)
        })
        if (!res.ok) throw new Error("Badge data unavailable")
        return res.json()
      }
      const [sessions, approvals] = await Promise.all([get("/sessions"), get("/approvals?pending=1")])
      if (Array.isArray(sessions) && Array.isArray(approvals)) apply(notificationCount(sessions as Array<AgentSession>, approvals as Array<Approval>, seen))
    } catch {
      // A temporary daemon outage must not clear outstanding attention.
    } finally { polling = false }
  }
  return {
    refresh,
    stop: () => { stopped = true },
    update: (count: unknown, readState: unknown) => {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return
      if (!readState || typeof readState !== "object" || Array.isArray(readState)) return
      const entries = Object.entries(readState)
      if (entries.length > 10_000 || entries.some(([id, value]) => id.length > 256 || typeof value !== "number" || !Number.isSafeInteger(value) || value < -1)) return
      seen = Object.fromEntries(entries)
      apply(count)
    }
  }
}
