import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"
import { type Cause, Deferred, Duration, Effect, Queue, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
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
  readonly kill: (signal?: ChildProcess.Signal) => Effect.Effect<void>
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
  /** Optional sandbox command prefix; `{cwd}` is substituted with the working directory. */
  readonly sandboxPrefix?: ReadonlyArray<string>
}

/** Environment variables never forwarded to agent harnesses. */
export const SENSITIVE_ENV = [
  "AGENTDESK_TOKEN",
  "JIRA_TOKEN",
  "JIRA_API_TOKEN",
  "ATLASSIAN_API_TOKEN",
  "GITLAB_TOKEN",
  "GL_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN"
]

export const buildChildEnv = (extra: Readonly<Record<string, string>> = {}, strip: ReadonlyArray<string> = []): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of [...SENSITIVE_ENV, ...strip]) delete env[k]
  return { ...env, ...extra }
}

const toHarnessError = (harness: string, command: string) => (e: unknown) => {
  const tag = (e as { reason?: { _tag?: string } }).reason?._tag
  return new HarnessError({
    harness,
    reason: tag === "NotFound" ? "not_installed" : "spawn_failed",
    message: `Failed to start ${command}: ${(e as { message?: string }).message ?? String(e)}`
  })
}

/**
 * Builds an `effect/process` command. The process runs detached in its own
 * process group, so closing the owning Scope terminates the whole tree
 * (SIGTERM, then SIGKILL after `killGraceMs`). Credentials are stripped from
 * the inherited environment. An optional sandbox prefix wraps the command.
 */
export const buildCommand = (opts: SpawnOptions) => {
  const command = ChildProcess.make(opts.command, [...opts.args], {
    cwd: opts.cwd,
    env: buildChildEnv(opts.env, opts.stripEnv),
    extendEnv: false,
    detached: true,
    killSignal: "SIGTERM",
    forceKillAfter: Duration.millis(opts.killGraceMs ?? 3000)
  })
  const prefix = (opts.sandboxPrefix ?? []).map((p) => p.replaceAll("{cwd}", opts.cwd))
  return prefix.length > 0 ? ChildProcess.prefix(command, prefix[0]!, prefix.slice(1)) : command
}

/**
 * Spawns a long-lived harness process bound to the current Scope via
 * `effect/process`. Stdin is fed from a queue so writes are ordered and
 * non-blocking; stdout is exposed as a line stream; stderr keeps a tail.
 */
export const spawnManaged = (
  opts: SpawnOptions
): Effect.Effect<ManagedProcess, HarnessError, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(buildCommand(opts)).pipe(Effect.mapError(toHarnessError(opts.harness, opts.command)))
    const exited = yield* Deferred.make<ProcessExit>()
    const stdin = yield* Queue.unbounded<string, Cause.Done>()
    let stderr = ""
    const encoder = new TextEncoder()

    yield* Stream.fromQueue(stdin).pipe(
      Stream.map((s) => encoder.encode(s)),
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkScoped
    )
    yield* handle.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderr = (stderr + chunk).slice(-8000)
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    )
    // The exit watcher must outlive the scope: closing the scope terminates the
    // process, and `exited` has to observe that. Its lifetime is bounded by the
    // child process, which the scope always kills.
    yield* handle.exitCode.pipe(
      Effect.map((code): ProcessExit => ({ code: Number(code), signal: null })),
      Effect.orElseSucceed((): ProcessExit => ({ code: null, signal: "SIGTERM" })),
      Effect.flatMap((exit) => Deferred.succeed(exited, exit)),
      Effect.andThen(Queue.end(stdin)),
      Effect.forkDetach
    )

    return {
      pid: Number(handle.pid),
      lines: handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.catch(() => Stream.empty)
      ),
      stderrTail: () => stderr,
      write: (data) =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(exited)) {
            return yield* new HarnessError({ harness: opts.harness, reason: "closed", message: "Process is not running" })
          }
          yield* Queue.offer(stdin, data)
        }),
      exited: Deferred.await(exited),
      kill: (signal = "SIGTERM") => handle.kill({ killSignal: signal }).pipe(Effect.ignore)
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

const collect = (s: Stream.Stream<Uint8Array, unknown>) =>
  s.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => "")
  )

/**
 * Run a short-lived command and collect its output. Never fails: a spawn
 * error or timeout is reported as code -1 / null. The process is scoped, so
 * a timeout or interruption kills it.
 */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; timeoutMs?: number; env?: Readonly<Record<string, string>>; input?: string } = {}
): Effect.Effect<CommandResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [...args], {
          ...(options.cwd && { cwd: options.cwd }),
          env: buildChildEnv(options.env),
          extendEnv: false,
          detached: true,
          forceKillAfter: Duration.seconds(2)
        })
      )
      const input = options.input ?? ""
      yield* Stream.make(new TextEncoder().encode(input)).pipe(Stream.run(handle.stdin), Effect.ignore, Effect.forkScoped)
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collect(handle.stdout),
          collect(handle.stderr),
          handle.exitCode.pipe(
            Effect.map(Number),
            Effect.orElseSucceed(() => -1)
          )
        ],
        { concurrency: "unbounded" }
      )
      return { code, stdout, stderr } satisfies CommandResult
    })
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(options.timeoutMs ?? 30_000),
      orElse: () => Effect.succeed<CommandResult>({ code: null, stdout: "", stderr: `Timed out after ${options.timeoutMs ?? 30_000}ms` })
    }),
    Effect.catch((e) => Effect.succeed<CommandResult>({ code: -1, stdout: "", stderr: String((e as { message?: string }).message ?? e) }))
  )

/** Node implementation of the process services, for tests and composition roots. */
export { layer as NodeProcessLayer } from "@effect/platform-node/NodeServices"
