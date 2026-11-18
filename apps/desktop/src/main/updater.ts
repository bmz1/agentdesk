/**
 * In-app updates from GitHub releases (electron-updater). Checks shortly after launch
 * and every few hours, downloads in the background, and installs only when the user asks:
 * installing restarts the app and the background daemon it started, which interrupts
 * running agent work. Electron-free so it can be tested with a fake updater.
 */

export type UpdateStatus = "unsupported" | "idle" | "checking" | "downloading" | "ready" | "error"

export interface UpdateState {
  readonly status: UpdateStatus
  readonly currentVersion: string
  /** The newer release being downloaded or ready to install. */
  readonly availableVersion?: string
  readonly percent?: number
  readonly message?: string
  readonly checkedAt?: string
}

/** The slice of electron-updater's AppUpdater this module drives. */
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: "checking-for-update", listener: () => void): unknown
  on(event: "update-available", listener: (info: { version: string }) => void): unknown
  on(event: "update-not-available", listener: (info: { version: string }) => void): unknown
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown
  on(event: "update-downloaded", listener: (info: { version: string }) => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

interface UpdaterOptions {
  currentVersion: string
  /** Null when updates cannot work in this build (development, unsupported package). */
  updater: UpdaterLike | null
  unsupportedReason?: string
  broadcast: (state: UpdateState) => void
  /** Runs before installing; returning false cancels the install. */
  prepareInstall: () => Promise<boolean>
  now?: () => Date
  initialDelayMs?: number
  intervalMs?: number
}

export const createUpdater = (options: UpdaterOptions) => {
  const now = options.now ?? (() => new Date())
  let state: UpdateState = options.updater
    ? { status: "idle", currentVersion: options.currentVersion }
    : { status: "unsupported", currentVersion: options.currentVersion, message: options.unsupportedReason ?? "Updates are only available in installed builds." }
  const set = (next: Omit<UpdateState, "currentVersion">) => {
    state = { currentVersion: options.currentVersion, ...next }
    options.broadcast(state)
  }
  const current = () => state
  const timers: Array<ReturnType<typeof setTimeout>> = []
  let installing = false

  const updater = options.updater
  if (updater) {
    updater.autoDownload = true
    // Never install silently on quit: installing restarts the daemon and its agent work.
    updater.autoInstallOnAppQuit = false
    updater.on("checking-for-update", () => {
      // A downloaded update stays ready; periodic checks must not hide it.
      if (state.status !== "ready" && state.status !== "downloading") set({ status: "checking" })
    })
    updater.on("update-available", (info) => set({ status: "downloading", availableVersion: info.version, percent: 0 }))
    updater.on("download-progress", (p) => {
      if (state.status === "downloading") set({ ...state, percent: Math.round(p.percent) })
    })
    updater.on("update-not-available", () => set({ status: "idle", checkedAt: now().toISOString() }))
    updater.on("update-downloaded", (info) => set({ status: "ready", availableVersion: info.version, checkedAt: now().toISOString() }))
    updater.on("error", (error) => {
      if (state.status === "ready") return
      set({ status: "error", message: error.message.split("\n")[0], checkedAt: now().toISOString() })
    })
  }

  const check = async () => {
    if (!updater || state.status === "checking" || state.status === "downloading" || state.status === "ready") return state
    try {
      await updater.checkForUpdates()
    } catch (e) {
      // electron-updater also emits "error"; this covers failures before it starts.
      // (Read through a function: the await may have changed state.)
      const status = current().status
      if (status === "checking" || status === "idle")
        set({ status: "error", message: (e instanceof Error ? e.message : String(e)).split("\n")[0], checkedAt: now().toISOString() })
    }
    return state
  }

  const install = async () => {
    if (!updater || state.status !== "ready" || installing) return false
    installing = true
    try {
      if (!(await options.prepareInstall())) return false
      updater.quitAndInstall(false, true)
      return true
    } finally {
      installing = false
    }
  }

  return {
    state: () => state,
    check,
    install,
    start: () => {
      if (!updater) return
      timers.push(setTimeout(() => void check(), options.initialDelayMs ?? 15_000))
      const interval = setInterval(() => void check(), options.intervalMs ?? 4 * 60 * 60 * 1000)
      interval.unref?.()
      timers.push(interval)
    },
    stop: () => {
      for (const t of timers) clearTimeout(t)
    }
  }
}

interface DaemonInfo {
  pid: number
  persistent: boolean
  activeSessions: number
  activeRuns: number
}

interface PrepareDaemonOptions {
  connection: () => { url: string; token: string } | undefined
  /** Asked only when agent work is running; resolves true to go ahead. */
  confirm: (active: { sessions: number; runs: number }) => Promise<boolean>
  fetch?: typeof fetch
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
}

/**
 * Stops the background daemon the app started, so the updated app starts the new one.
 * A supervised service (launchd/systemd) is left alone: it is not part of the app bundle.
 */
export const prepareDaemonForUpdate = async (options: PrepareDaemonOptions): Promise<boolean> => {
  const connection = options.connection()
  if (!connection) return true
  let info: DaemonInfo
  try {
    const res = await (options.fetch ?? fetch)(`${connection.url}/info`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(3000)
    })
    if (!res.ok) return true
    info = (await res.json()) as DaemonInfo
  } catch {
    return true // Not running: nothing to stop.
  }
  if (info.persistent || !Number.isInteger(info.pid) || info.pid <= 0) return true
  if (info.activeSessions + info.activeRuns > 0 && !(await options.confirm({ sessions: info.activeSessions, runs: info.activeRuns }))) {
    return false
  }
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const alive = () => {
    try {
      kill(info.pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    kill(info.pid, "SIGTERM")
  } catch {
    return true
  }
  // The daemon shuts down gracefully (its own hard limit is 15s); wait for it to release the database.
  const deadline = options.timeoutMs ?? 20_000
  for (let waited = 0; waited < deadline && alive(); waited += 250) await sleep(250)
  return true
}
