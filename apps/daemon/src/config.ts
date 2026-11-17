import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Context, Effect, Layer } from "effect"

export interface DaemonConfigShape {
  readonly version: string
  readonly dataDir: string
  readonly dbPath: string
  readonly worktreesDir: string
  readonly artifactsDir: string
  readonly host: string
  readonly port: number
  /** Per-install secret required on every API request. */
  readonly token: string
  readonly allowedOrigins: ReadonlyArray<string>
  /** True when supervised by launchd/systemd so it survives the desktop app quitting. */
  readonly persistent: boolean
  readonly maxConcurrentRuns: number
  readonly maxRunsPerProject: number
  readonly enableJiraPolling: boolean
  readonly workflowsDir: string
  readonly promptsDir: string
}

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

const loadOrCreateToken = (dataDir: string): string => {
  const file = join(dataDir, "token")
  if (process.env.AGENTDESK_TOKEN) return process.env.AGENTDESK_TOKEN
  if (existsSync(file)) return readFileSync(file, "utf8").trim()
  const token = randomBytes(32).toString("base64url")
  writeFileSync(file, token, { mode: 0o600 })
  return token
}

export const makeConfig = (overrides: Partial<DaemonConfigShape> = {}): DaemonConfigShape => {
  const dataDir = overrides.dataDir ?? defaultDataDir()
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dataDir, 0o700)
  } catch {
    /* best effort */
  }
  const worktreesDir = overrides.worktreesDir ?? join(dataDir, "worktrees")
  const artifactsDir = overrides.artifactsDir ?? join(dataDir, "artifacts")
  mkdirSync(worktreesDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })
  const env = process.env
  return {
    version: VERSION,
    dataDir,
    dbPath: overrides.dbPath ?? join(dataDir, "agentdesk.db"),
    worktreesDir,
    artifactsDir,
    host: "127.0.0.1",
    port: overrides.port ?? Number(env.AGENTDESK_PORT ?? 4317),
    token: overrides.token ?? loadOrCreateToken(dataDir),
    allowedOrigins: overrides.allowedOrigins ?? [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "file://",
      "null",
      ...(env.AGENTDESK_ALLOWED_ORIGINS?.split(",").filter(Boolean) ?? [])
    ],
    persistent: overrides.persistent ?? env.AGENTDESK_PERSISTENT === "1",
    maxConcurrentRuns: overrides.maxConcurrentRuns ?? Number(env.AGENTDESK_MAX_RUNS ?? 3),
    maxRunsPerProject: overrides.maxRunsPerProject ?? Number(env.AGENTDESK_MAX_RUNS_PER_PROJECT ?? 2),
    enableJiraPolling: overrides.enableJiraPolling ?? env.AGENTDESK_DISABLE_JIRA_POLLING !== "1",
    workflowsDir: overrides.workflowsDir ?? env.AGENTDESK_WORKFLOWS_DIR ?? fileURLToPath(new URL("../../../workflows", import.meta.url)),
    promptsDir: overrides.promptsDir ?? env.AGENTDESK_PROMPTS_DIR ?? fileURLToPath(new URL("../../../prompts", import.meta.url))
  }
}

export const DaemonConfigLive = (overrides: Partial<DaemonConfigShape> = {}) =>
  Layer.effect(DaemonConfig, Effect.sync(() => makeConfig(overrides)))
