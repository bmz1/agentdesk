import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { redactSecrets } from "@agentdesk/harness-core"
import { Layer, Logger } from "effect"

const MAX_BYTES = 10 * 1024 * 1024

/**
 * Structured JSON-lines file logger (with span/annotation context such as
 * runId), redacted and size-rotated, alongside the default console logger.
 */
export const fileLoggerLayer = (path: string | undefined) => {
  if (!path) return Layer.empty
  mkdirSync(dirname(path), { recursive: true })
  const fileLogger = Logger.map(Logger.formatJson, (line) => {
    try {
      if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
      appendFileSync(path, redactSecrets(line) + "\n", { mode: 0o600 })
    } catch {
      /* logging must never take the daemon down */
    }
  })
  return Logger.layer([Logger.defaultLogger, fileLogger])
}
