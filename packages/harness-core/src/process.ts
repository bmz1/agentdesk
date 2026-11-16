import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { createInterface } from "node:readline"
import { Deferred, Effect, Queue, Scope, Stream } from "effect"
import { HarnessError } from "./errors"

export interface ProcessExit {
  readonly code: number | null
  readonly signal: string | null
}

export interface ManagedProcess {
  readonly pid: number | undefined
  /** Stdout split into lines. Single consumer. Ends when stdout closes. */
  readonly lines: Stream.Stream<string>
  readonly stderrTail: () => string
  readonly write: (data: string) => Effect.Effect<void, HarnessError>
  readonly exited: Effect.Effect<ProcessExit>
  readonly isRunning: () => boolean
  readonly kill: (signal?: NodeJS.Signals) => Effect.Effect<void>
}

export interface SpawnOptions {
  readonly harness: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** Remove these variables from the inherited environment (e.g. credentials). */
  readonly stripEnv?: ReadonlyArray<string>
  /** Grace period between SIGTERM and SIGKILL on release. */
  readonly killGraceMs?: number
}

/** Environment variables never forwarded to agent harnesses. */
export const SENSITIVE_ENV = [
  "AGENTDESK_TOKEN",
  "JIRA_TOKEN",
  "JIRA_API_TOKEN",
  "ATLASSIAN_API_TOKEN",
  "GITLAB_TOKEN",
  "GL_TOKEN"
]

export const buildChildEnv = (
  extra: Readonly<Record<string, string>> = {},
  strip: ReadonlyArray<string> = []
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of [...SENSITIVE_ENV, ...strip]) delete env[k]
  return { ...env, ...extra }
}

const killTree = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid === undefined) return
  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawns a child process bound to the current Scope. Closing the scope sends
 * SIGTERM to the whole process group and escalates to SIGKILL after a grace period.
 */
export const spawnManaged = (opts: SpawnOptions): Effect.Effect<ManagedProcess, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const lineQueue = yield* Queue.unbounded<string, import("effect").Cause.Done>()
    const exitDeferred = yield* Deferred.make<ProcessExit>()
    let stderr = ""
    let running = true

    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(opts.command, [...opts.args], {
            cwd: opts.cwd,
            env: buildChildEnv(opts.env, opts.stripEnv),
            stdio: ["pipe", "pipe", "pipe"],
            detached: true
          }),
        catch: (cause) =>
          new HarnessError({
            harness: opts.harness,
            reason: "spawn_failed",
            message: `Failed to spawn ${opts.command}: ${String(cause)}`,
            cause
          })
      }),
      (child) =>
        Effect.gen(function* () {
          if (!running) return
          killTree(child, "SIGTERM")
          const exited = yield* Deferred.await(exitDeferred).pipe(
            Effect.timeoutOption(opts.killGraceMs ?? 3000)
          )
          if (exited._tag === "None") killTree(child, "SIGKILL")
        })
    )

    yield* Effect.callback<void, HarnessError>((resume) => {
      const onSpawn = () => {
        cleanup()
        resume(Effect.void)
      }
      const onError = (cause: Error) => {
        cleanup()
        running = false
        resume(
          Effect.fail(
            new HarnessError({
              harness: opts.harness,
              reason: (cause as NodeJS.ErrnoException).code === "ENOENT" ? "not_installed" : "spawn_failed",
              message: `Failed to start ${opts.command}: ${cause.message}`,
              cause
            })
          )
        )
      }
      const cleanup = () => {
        child.off("spawn", onSpawn)
        child.off("error", onError)
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })

    child.on("error", () => {
      /* post-spawn errors surface via exit */
    })
    child.stdin?.on("error", () => {
      /* EPIPE when the child exits first; surfaced via exit */
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    rl.on("line", (line) => {
      Queue.offerUnsafe(lineQueue, line)
    })
    rl.on("close", () => {
      Queue.endUnsafe(lineQueue)
    })
    child.on("exit", (code, signal) => {
      running = false
      Deferred.doneUnsafe(exitDeferred, Effect.succeed({ code, signal }))
    })

    const write = (data: string) =>
      Effect.callback<void, HarnessError>((resume) => {
        if (!running || !child.stdin || child.stdin.destroyed) {
          resume(
            Effect.fail(new HarnessError({ harness: opts.harness, reason: "closed", message: "Process is not running" }))
          )
          return
        }
        child.stdin.write(data, (err) => {
          if (err) {
            resume(Effect.fail(new HarnessError({ harness: opts.harness, reason: "io", message: err.message, cause: err })))
          } else resume(Effect.void)
        })
      })

    return {
      pid: child.pid,
      lines: Stream.fromQueue(lineQueue),
      stderrTail: () => stderr,
      write,
      exited: Deferred.await(exitDeferred),
      isRunning: () => running,
      kill: (signal: NodeJS.Signals = "SIGTERM") => Effect.sync(() => killTree(child, signal))
    } satisfies ManagedProcess
  })

/** Locate an executable on PATH (plus common user install locations). */
export const findExecutable = (name: string, extraDirs: ReadonlyArray<string> = []): string | undefined => {
  const home = process.env.HOME ?? ""
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    ...extraDirs,
    join(home, ".local/bin"),
    join(home, ".npm-global/bin"),
    join(home, ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* continue */
    }
  }
  return undefined
}

export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Run a short-lived command and collect its output. Never fails; inspect `code`. */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; timeoutMs?: number; env?: Readonly<Record<string, string>>; input?: string } = {}
): Effect.Effect<CommandResult> =>
  Effect.callback<CommandResult>((resume) => {
    let stdout = ""
    let stderr = ""
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: buildChildEnv(options.env),
        stdio: ["pipe", "pipe", "pipe"]
      })
    } catch (e) {
      resume(Effect.succeed({ code: -1, stdout: "", stderr: String(e) }))
      return
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30_000)
    child.stdout?.on("data", (d) => (stdout += d))
    child.stderr?.on("data", (d) => (stderr += d))
    child.on("error", (e) => {
      clearTimeout(timer)
      resume(Effect.succeed({ code: -1, stdout, stderr: stderr + String(e) }))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resume(Effect.succeed({ code, stdout, stderr }))
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
    else child.stdin?.end()
    return Effect.sync(() => {
      clearTimeout(timer)
      child.kill("SIGKILL")
    })
  })
