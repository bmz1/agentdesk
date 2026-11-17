import { rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { serve, type ServerType } from "@hono/node-server"
import { Effect } from "effect"
import { connectionFilePath, type ConnectionFile, DaemonConfig, type DaemonConfigShape } from "./config"
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

export const startDaemon = async (options: StartDaemonOptions = {}): Promise<RunningDaemon> => {
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
  }
  return { url, config: { ...config, port }, runtime, stop }
}
