import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { findExecutable, runCommand } from "@agentdesk/harness-core"
import { Context, Effect, Layer, Redacted } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { DaemonConfig } from "../config"
import { BadRequest } from "../errors"

/**
 * Secrets (task-source API tokens) live in the OS credential store, never in SQLite or
 * logs. SQLite only stores an opaque `credentialRef`. Values cross this
 * boundary as `Redacted`, so they can't leak through logging or spans.
 */
export interface CredentialStoreShape {
  readonly kind: "keychain" | "secret-service" | "file" | "memory" | "none"
  readonly set: (ref: string, secret: Redacted.Redacted<string>) => Effect.Effect<void, BadRequest>
  readonly get: (ref: string) => Effect.Effect<Redacted.Redacted<string> | undefined>
  readonly remove: (ref: string) => Effect.Effect<void>
}

export class CredentialStore extends Context.Service<CredentialStore, CredentialStoreShape>()("agentdesk/CredentialStore") {}

const SERVICE = "agentdesk"
type Run = typeof runCommand
type RunNoDeps = (...args: Parameters<Run>) => Effect.Effect<Effect.Success<ReturnType<Run>>>

export const makeMemoryStore = (): CredentialStoreShape => {
  const m = new Map<string, Redacted.Redacted<string>>()
  return {
    kind: "memory",
    set: (ref, secret) => Effect.sync(() => void m.set(ref, secret)),
    get: (ref) => Effect.sync(() => m.get(ref)),
    remove: (ref) => Effect.sync(() => void m.delete(ref))
  }
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const present = (stdout: string) => (stdout ? Redacted.make(stdout.replace(/\n$/, "")) : undefined)

/** macOS Keychain via `security`. The secret is passed on stdin (`security -i`), never argv. */
const makeKeychainStore = (bin: string, run: RunNoDeps): CredentialStoreShape => ({
  kind: "keychain",
  set: (ref, secret) =>
    run(bin, ["-i"], {
      input: `add-generic-password -U -s ${SERVICE} -a ${quote(ref)} -l ${quote(`AgentDesk ${ref}`)} -w ${quote(Redacted.value(secret))}\n`
    }).pipe(
      Effect.flatMap((r) =>
        r.code === 0 && !/error/i.test(r.stderr) ? Effect.void : Effect.fail(new BadRequest({ message: `Keychain write failed: ${r.stderr.trim()}` }))
      )
    ),
  get: (ref) =>
    run(bin, ["find-generic-password", "-s", SERVICE, "-a", ref, "-w"]).pipe(
      Effect.map((r) => (r.code === 0 ? present(r.stdout) : undefined))
    ),
  remove: (ref) => run(bin, ["delete-generic-password", "-s", SERVICE, "-a", ref]).pipe(Effect.asVoid)
})

/** Linux Secret Service via libsecret's `secret-tool`. Secret is passed on stdin. */
const makeSecretToolStore = (bin: string, run: RunNoDeps): CredentialStoreShape => ({
  kind: "secret-service",
  set: (ref, secret) =>
    run(bin, ["store", `--label=AgentDesk ${ref}`, "service", SERVICE, "account", ref], { input: Redacted.value(secret) }).pipe(
      Effect.flatMap((r) =>
        r.code === 0 ? Effect.void : Effect.fail(new BadRequest({ message: `Secret Service write failed: ${r.stderr.trim()}` }))
      )
    ),
  get: (ref) =>
    run(bin, ["lookup", "service", SERVICE, "account", ref]).pipe(Effect.map((r) => (r.code === 0 ? present(r.stdout) : undefined))),
  remove: (ref) => run(bin, ["clear", "service", SERVICE, "account", ref]).pipe(Effect.asVoid)
})

/** Explicit opt-in fallback (AGENTDESK_ALLOW_FILE_CREDENTIALS=1): a 0600 file outside SQLite. */
const makeFileStore = (dataDir: string): CredentialStoreShape => {
  const file = join(dataDir, "credentials.json")
  const read = (): Record<string, string> => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {})
  const write = (d: Record<string, string>) => {
    writeFileSync(file, JSON.stringify(d), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return {
    kind: "file",
    set: (ref, secret) => Effect.sync(() => write({ ...read(), [ref]: Redacted.value(secret) })),
    get: (ref) => Effect.sync(() => present(read()[ref] ?? "")),
    remove: (ref) =>
      Effect.sync(() => {
        const d = read()
        delete d[ref]
        write(d)
      })
  }
}

const unavailable: CredentialStoreShape = {
  kind: "none",
  set: () =>
    Effect.fail(
      new BadRequest({
        message:
          "No secure credential store available (macOS Keychain or Secret Service). Set AGENTDESK_ALLOW_FILE_CREDENTIALS=1 to opt into a 0600 file store."
      })
    ),
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void
}

export const CredentialStoreLive = (mode: "auto" | "memory" = "auto") =>
  Layer.effect(
    CredentialStore,
    Effect.gen(function* () {
      if (mode === "memory") return makeMemoryStore()
      const config = yield* DaemonConfig
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const run: RunNoDeps = (...args) => runCommand(...args).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      if (process.platform === "darwin") {
        const bin = findExecutable("security", ["/usr/bin"])
        if (bin) return makeKeychainStore(bin, run)
      }
      const secretTool = findExecutable("secret-tool")
      if (secretTool && process.env.DBUS_SESSION_BUS_ADDRESS) return makeSecretToolStore(secretTool, run)
      if (process.env.AGENTDESK_ALLOW_FILE_CREDENTIALS === "1") return makeFileStore(config.dataDir)
      return unavailable
    })
  )
