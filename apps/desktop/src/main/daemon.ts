import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { app } from "electron"

export interface DaemonConnection {
  readonly url: string
  readonly token: string
  readonly pid?: number
  readonly version?: string
  /** True when this app process spawned the daemon (vs. a launchd/systemd service or manual start). */
  readonly spawnedByApp: boolean
}

const dataDir = () => process.env.AGENTDESK_HOME ?? join(homedir(), ".agentdesk")

const readConnectionFile = (): Omit<DaemonConnection, "spawnedByApp"> | undefined => {
  const file = join(dataDir(), "daemon.json")
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

const healthy = async (url: string) => {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Locate the daemon entrypoint: bundled build in production, TS sources in development. */
const daemonCommand = (): { command: string; args: Array<string>; env: NodeJS.ProcessEnv } | undefined => {
  const bundled = app.isPackaged
    ? join(process.resourcesPath, "daemon", "main.js")
    : resolve(__dirname, "../../../daemon/dist/main.js")
  if (existsSync(bundled)) {
    return { command: process.execPath, args: [bundled], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
  }
  const source = resolve(__dirname, "../../../daemon/src/main.ts")
  if (!app.isPackaged && existsSync(source)) {
    return { command: "npx", args: ["tsx", source], env: process.env }
  }
  return undefined
}

let spawned = false

/**
 * Find a running daemon, or start one as a detached background process.
 * The daemon owns agent processes; Electron never does. A detached daemon keeps
 * running after the window closes, but is *not* a login service — the UI says so.
 */
export const ensureDaemon = async (): Promise<DaemonConnection | undefined> => {
  const existing = readConnectionFile()
  if (existing && (await healthy(existing.url))) return { ...existing, spawnedByApp: spawned }
  if (process.env.AGENTDESK_NO_SPAWN === "1") return undefined
  const cmd = daemonCommand()
  if (!cmd) return undefined
  const child = spawn(cmd.command, cmd.args, { detached: true, stdio: "ignore", env: cmd.env })
  child.unref()
  spawned = true
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const conn = readConnectionFile()
    if (conn && (await healthy(conn.url))) return { ...conn, spawnedByApp: true }
  }
  return undefined
}
