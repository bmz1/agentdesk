import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"

export interface DaemonConfigShape {
  readonly version: string
  readonly dataDir: string
  readonly dbPath: string
  readonly worktreesDir: string
  readonly artifactsDir: string
  readonly host: string
  readonly port: number
  /** Per-install secret required on every API request. Redacted so it never lands in logs or spans. */
  readonly token: Redacted.Redacted<string>
  readonly allowedOrigins: ReadonlyArray<string>
  /** True when supervised by launchd/systemd so it survives the desktop app quitting. */
  readonly persistent: boolean
  readonly maxConcurrentRuns: number
  readonly maxRunsPerProject: number
  readonly enableSourcePolling: boolean
  readonly workflowsDir: string
  readonly promptsDir: string
  /** Command prefix confining harness processes; required for "unrestricted" mode. `{cwd}` is substituted. */
  readonly sandboxPrefix: ReadonlyArray<string> | undefined
  /** Agent event transcripts of ended sessions older than this are pruned (audit activity is kept). */
  readonly retentionDays: number
  readonly logFile: string | undefined
  /** OTLP/HTTP collector base URL; tracing export is enabled when set. */
  readonly otlpEndpoint: string | undefined
}

/** Test/embedding overrides; `token` may be given as plain text. */
export type ConfigOverrides = Partial<Omit<DaemonConfigShape, "token">> & { readonly token?: string }

export class DaemonConfig extends Context.Service<DaemonConfig, DaemonConfigShape>()("agentdesk/DaemonConfig") {}

export const VERSION = "0.1.0"

export const defaultDataDir = () => process.env.AGENTDESK_HOME ?? join(homedir(), ".agentdesk")

/** Connection file the desktop shell reads to find and authenticate to the daemon. */
export interface ConnectionFile {
  readonly url: string
  readonly token: string
  readonly pid: number
  readonly version: string
}

export const connectionFilePath = (dataDir: string) => join(dataDir, "daemon.json")

/** AGENTDESK_SANDBOX_CMD: a JSON array (preferred) or a whitespace-separated command prefix. */
export const parseSandbox = (raw: string | undefined): ReadonlyArray<string> | undefined => {
  if (!raw?.trim()) return undefined
  if (raw.trim().startsWith("[")) return JSON.parse(raw) as Array<string>
  return raw.trim().split(/\s+/)
}

/** Environment-driven settings, declared with the Effect Config module (validated, typed, defaulted). */
const EnvConfig = Config.all({
  home: Config.String("AGENTDESK_HOME").pipe(Config.withDefault(join(homedir(), ".agentdesk"))),
  // 0 = ephemeral port (tests, embedded use); otherwise a regular TCP port.
  port: Config.schema(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 65535 })), "AGENTDESK_PORT").pipe(
    Config.withDefault(4317)
  ),
  token: Config.Redacted("AGENTDESK_TOKEN").pipe(Config.option),
  allowedOrigins: Config.String("AGENTDESK_ALLOWED_ORIGINS").pipe(Config.withDefault("")),
  persistent: Config.String("AGENTDESK_PERSISTENT").pipe(Config.withDefault("0")),
  maxRuns: Config.Int("AGENTDESK_MAX_RUNS").pipe(Config.withDefault(3)),
  maxRunsPerProject: Config.Int("AGENTDESK_MAX_RUNS_PER_PROJECT").pipe(Config.withDefault(2)),
  disableSourcePolling: Config.String("AGENTDESK_DISABLE_SOURCE_POLLING").pipe(Config.withDefault("0")),
  /** @deprecated alias of AGENTDESK_DISABLE_SOURCE_POLLING */
  disableJiraPolling: Config.String("AGENTDESK_DISABLE_JIRA_POLLING").pipe(Config.withDefault("0")),
  workflowsDir: Config.String("AGENTDESK_WORKFLOWS_DIR").pipe(Config.option),
  promptsDir: Config.String("AGENTDESK_PROMPTS_DIR").pipe(Config.option),
  sandbox: Config.String("AGENTDESK_SANDBOX_CMD").pipe(Config.option),
  retentionDays: Config.Int("AGENTDESK_RETENTION_DAYS").pipe(Config.withDefault(90)),
  otlpEndpoint: Config.String("OTEL_EXPORTER_OTLP_ENDPOINT").pipe(Config.option)
})

const loadOrCreateToken = (dataDir: string): string => {
  const file = join(dataDir, "token")
  if (existsSync(file)) return readFileSync(file, "utf8").trim()
  const token = randomBytes(32).toString("base64url")
  writeFileSync(file, token, { mode: 0o600 })
  return token
}

/** Resolve configuration from the environment (via Config) plus explicit overrides, and prepare the data dir. */
export const loadConfig = Effect.fn("DaemonConfig.load")(function* (overrides: ConfigOverrides = {}) {
  const env = yield* EnvConfig
  const dataDir = overrides.dataDir ?? env.home
  const worktreesDir = overrides.worktreesDir ?? join(dataDir, "worktrees")
  const artifactsDir = overrides.artifactsDir ?? join(dataDir, "artifacts")
  yield* Effect.sync(() => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    try {
      chmodSync(dataDir, 0o700)
    } catch {
      /* best effort */
    }
    mkdirSync(worktreesDir, { recursive: true })
    mkdirSync(artifactsDir, { recursive: true })
  })
  const token =
    overrides.token !== undefined
      ? Redacted.make(overrides.token)
      : Option.isSome(env.token)
        ? env.token.value
        : Redacted.make(yield* Effect.sync(() => loadOrCreateToken(dataDir)))
  return {
    version: VERSION,
    dataDir,
    dbPath: overrides.dbPath ?? join(dataDir, "agentdesk.db"),
    worktreesDir,
    artifactsDir,
    host: "127.0.0.1",
    port: overrides.port ?? env.port,
    token,
    allowedOrigins: overrides.allowedOrigins ?? [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "file://",
      "null",
      ...env.allowedOrigins.split(",").filter(Boolean)
    ],
    persistent: overrides.persistent ?? env.persistent === "1",
    maxConcurrentRuns: overrides.maxConcurrentRuns ?? env.maxRuns,
    maxRunsPerProject: overrides.maxRunsPerProject ?? env.maxRunsPerProject,
    enableSourcePolling: overrides.enableSourcePolling ?? (env.disableSourcePolling !== "1" && env.disableJiraPolling !== "1"),
    workflowsDir:
      overrides.workflowsDir ?? Option.getOrElse(env.workflowsDir, () => fileURLToPath(new URL("../../../workflows", import.meta.url))),
    promptsDir:
      overrides.promptsDir ?? Option.getOrElse(env.promptsDir, () => fileURLToPath(new URL("../../../prompts", import.meta.url))),
    sandboxPrefix: overrides.sandboxPrefix ?? parseSandbox(Option.getOrUndefined(env.sandbox)),
    retentionDays: overrides.retentionDays ?? env.retentionDays,
    logFile: "logFile" in overrides ? overrides.logFile : join(dataDir, "logs", "daemon.log"),
    otlpEndpoint: "otlpEndpoint" in overrides ? overrides.otlpEndpoint : Option.getOrUndefined(env.otlpEndpoint)
  } satisfies DaemonConfigShape
})

export const DaemonConfigLive = (config: DaemonConfigShape) => Layer.succeed(DaemonConfig, config)
