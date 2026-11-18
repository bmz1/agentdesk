import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { serve, type ServerType } from "@hono/node-server"
import { Effect, Redacted } from "effect"
import { type ConfigOverrides, connectionFilePath, type ConnectionFile, type DaemonConfigShape, loadConfig } from "./config"
import { makeApp } from "./http/app"
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
  readonly config?: ConfigOverrides
  /** Write ~/.agentdesk/daemon.json so the desktop shell can discover us. */
  readonly writeConnectionFile?: boolean
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

/**
 * Composition root: resolve config (Effect Config), take the single-instance
 * lock, build the ManagedRuntime from the app Layer, reconcile durable state,
 * then serve HTTP. `stop` disposes the runtime, which closes every scope
 * (agent processes, pollers, run executors) in order.
 */
export const startDaemon = async (options: StartDaemonOptions = {}): Promise<RunningDaemon> => {
  const config = await Effect.runPromise(loadConfig(options.config))
  const releaseLock = acquireInstanceLock(config.dataDir)
  const runtime = makeRuntime(config, options)
  try {
    const { sessions, runs } = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* Sessions.use((s) => s.reconcile)
        const runs = yield* Workflows.use((w) => w.reconcile)
        return { sessions, runs }
      }).pipe(Effect.withSpan("Daemon.startup"))
    )
    if (sessions > 0) console.log(`[agentdesk] detached ${sessions} session(s) from the previous daemon (conversations resume on their next follow-up)`)
    if (runs > 0) console.log(`[agentdesk] marked ${runs} workflow run(s) interrupted`)
  } catch (e) {
    await runtime.dispose()
    releaseLock()
    throw e
  }

  const app = makeApp(runtime, config)
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => resolve(s))
  })
  const port = (server.address() as AddressInfo).port
  const url = `http://${config.host}:${port}`
  const connFile = connectionFilePath(config.dataDir)
  if (options.writeConnectionFile) {
    const conn: ConnectionFile = { url, token: Redacted.value(config.token), pid: process.pid, version: config.version }
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
