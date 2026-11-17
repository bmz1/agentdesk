import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { serve, type ServerType } from "@hono/node-server"
import { Effect } from "effect"
import { connectionFilePath, type ConnectionFile, DaemonConfig, type DaemonConfigShape, makeConfig } from "./config"
import { makeApp, type RouteRegistrar } from "./http/app"
import { type AppLayerOptions, type AppRuntime, makeRuntime } from "./runtime"
import { Sessions } from "./services/sessions"
import { Workflows } from "./services/workflows"

export interface RunningDaemon {
  readonly url: string
  readonly config: DaemonConfigShape
  readonly runtime: AppRuntime
  readonly stop: () => Promise<void>
}

export interface StartDaemonOptions extends AppLayerOptions {
  /** Write ~/.agentdesk/daemon.json so the desktop shell can discover us. */
  readonly writeConnectionFile?: boolean
  readonly extraRoutes?: ReadonlyArray<RouteRegistrar>
  readonly bootstrap?: (runtime: AppRuntime) => Promise<void>
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * One daemon per data directory: two daemons on one SQLite database would
 * both own agents and reconcile each other's runs.
 */
export const acquireInstanceLock = (dataDir: string) => {
  const file = join(dataDir, "daemon.lock")
  try {
    writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 })
  } catch {
    const pid = Number(readFileSync(file, "utf8").trim())
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`Another AgentDesk daemon (pid ${pid}) is already using ${dataDir}`)
    }
    writeFileSync(file, String(process.pid), { mode: 0o600 })
  }
  return () => rmSync(file, { force: true })
}

export const startDaemon = async (options: StartDaemonOptions = {}): Promise<RunningDaemon> => {
  const releaseLock = acquireInstanceLock(makeConfig(options.config).dataDir)
  const runtime = makeRuntime(options)
  const config = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* DaemonConfig
    })
  )
  const reconciled = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Sessions).reconcile
    })
  )
  if (reconciled > 0) console.log(`[agentdesk] reconciled ${reconciled} interrupted session(s)`)
  const runs = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Workflows).reconcile
    })
  )
  if (runs > 0) console.log(`[agentdesk] marked ${runs} workflow run(s) interrupted`)
  await options.bootstrap?.(runtime)

  const app = makeApp(runtime, config, options.extraRoutes)
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port
  const url = `http://${config.host}:${port}`
  const connFile = connectionFilePath(config.dataDir)
  if (options.writeConnectionFile) {
    const conn: ConnectionFile = { url, token: config.token, pid: process.pid, version: config.version }
    writeFileSync(connFile, JSON.stringify(conn, null, 2), { mode: 0o600 })
  }

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Force-close long-lived SSE connections.
      ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    })
    await runtime.dispose()
    if (options.writeConnectionFile) rmSync(connFile, { force: true })
    releaseLock()
  }
  return { url, config: { ...config, port }, runtime, stop }
}
