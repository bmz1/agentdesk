export interface Connection {
  readonly url: string
  readonly token: string
  readonly spawnedByApp?: boolean
}

interface Bridge {
  platform: string
  getConnection(): Promise<Connection | null>
  openExternal(url: string): Promise<void>
  revealPath(path: string): Promise<void>
  pickDirectory(): Promise<string | null>
}

declare global {
  interface Window {
    agentdesk?: Bridge
  }
}

export const bridge = (): Bridge | undefined => window.agentdesk

const STORAGE_KEY = "agentdesk.connection"

/**
 * Electron: ask the main process (which reads ~/.agentdesk/daemon.json).
 * Browser dev mode: `?daemon=<url>&token=<token>` once, then sessionStorage.
 */
export const resolveConnection = async (): Promise<Connection | null> => {
  const b = bridge()
  if (b) return b.getConnection()
  const params = new URLSearchParams(window.location.search)
  const url = params.get("daemon")
  const token = params.get("token")
  if (url && token) {
    const conn = { url, token }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(conn))
    params.delete("daemon")
    params.delete("token")
    const qs = params.toString()
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash)
    return conn
  }
  const stored = sessionStorage.getItem(STORAGE_KEY)
  return stored ? (JSON.parse(stored) as Connection) : null
}

export const openExternal = (url: string) => {
  const b = bridge()
  if (b) void b.openExternal(url)
  else window.open(url, "_blank", "noopener,noreferrer")
}
