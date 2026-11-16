#!/usr/bin/env node
import { startDaemon } from "./server"

const main = async () => {
  const daemon = await startDaemon({ writeConnectionFile: true })
  console.log(`[agentdesk] daemon ${daemon.config.version} listening on ${daemon.url} (pid ${process.pid})`)
  console.log(`[agentdesk] data dir: ${daemon.config.dataDir}`)
  if (!daemon.config.persistent) {
    console.log("[agentdesk] not running as a persistent service: stopping this process ends active agent work")
  }
  const shutdown = (signal: string) => {
    console.log(`[agentdesk] ${signal} received, shutting down gracefully`)
    const force = setTimeout(() => process.exit(1), 15_000)
    force.unref()
    daemon.stop().then(
      () => process.exit(0),
      (e) => {
        console.error(e)
        process.exit(1)
      }
    )
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((e) => {
  console.error("[agentdesk] failed to start:", e)
  process.exit(1)
})
