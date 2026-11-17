import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeMockAdapter } from "@agentdesk/harness-core"
import { Effect, Layer, Tracer } from "effect"
import { type ConfigOverrides, loadConfig } from "../src/config"
import { type AppLayerOptions, makeAppLayer } from "../src/runtime"

export const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-repo-"))
  execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "# demo\n")
  execSync("git add . && git commit -qm init", { cwd: dir })
  return dir
}

/**
 * The real application Layer (SQLite, services, process spawner) on a fresh
 * temp data dir, with the mock harness and in-memory credentials. Built inside
 * each test so services pick up that test's TestClock / tracer.
 */
export const TestApp = (overrides: ConfigOverrides = {}, options: AppLayerOptions = {}) =>
  Layer.unwrap(
    loadConfig({
      dataDir: mkdtempSync(join(tmpdir(), "agentdesk-svc-")),
      port: 0,
      token: "test",
      enableSourcePolling: false,
      logFile: undefined,
      otlpEndpoint: undefined,
      ...overrides
    }).pipe(
      Effect.map((config) =>
        makeAppLayer(config, { adapters: [makeMockAdapter({ delayMs: 0 })], credentialStore: "memory", ...options })
      ),
      Effect.orDie
    )
  )

export interface RecordedSpan {
  readonly name: string
  readonly parent: string | undefined
  readonly attributes: Record<string, unknown>
}

/** An in-memory tracer recording every finished span (name, parent, attributes). */
export const makeRecordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const recorded = (): Array<RecordedSpan> =>
    spans.map((s) => ({
      name: s.name,
      parent: s.parent._tag === "Some" && s.parent.value._tag === "Span" ? s.parent.value.name : undefined,
      attributes: Object.fromEntries(s.attributes)
    }))
  return { tracer, recorded }
}
