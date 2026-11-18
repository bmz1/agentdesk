import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { createUpdater, prepareDaemonForUpdate, type UpdateState, type UpdaterLike } from "../src/main/updater"

const fakeUpdater = () => {
  const events = new EventEmitter()
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    on: (event: string, listener: (...args: Array<never>) => void) => events.on(event, listener),
    checkForUpdates: vi.fn(async () => {
      events.emit("checking-for-update")
      return null
    }),
    quitAndInstall: vi.fn()
  }
  return { updater: updater as unknown as UpdaterLike & typeof updater, emit: (event: string, ...args: Array<unknown>) => events.emit(event, ...args) }
}

const setup = (prepareInstall = async () => true) => {
  const { updater, emit } = fakeUpdater()
  const states: Array<UpdateState> = []
  const updates = createUpdater({
    currentVersion: "0.1.0",
    updater,
    broadcast: (s) => states.push(s),
    prepareInstall,
    now: () => new Date("2026-11-18T12:00:00Z")
  })
  return { updater, emit, states, updates }
}

describe("updater", () => {
  it("downloads in the background but never installs on quit", () => {
    const { updater } = setup()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it("tracks a release from check to ready", async () => {
    const { emit, updates } = setup()
    await updates.check()
    expect(updates.state().status).toBe("checking")
    emit("update-available", { version: "0.2.0" })
    emit("download-progress", { percent: 41.6 })
    expect(updates.state()).toMatchObject({ status: "downloading", availableVersion: "0.2.0", percent: 42 })
    emit("update-downloaded", { version: "0.2.0" })
    expect(updates.state()).toMatchObject({ status: "ready", availableVersion: "0.2.0", currentVersion: "0.1.0" })
  })

  it("reports up to date and errors", async () => {
    const { emit, updates } = setup()
    await updates.check()
    emit("update-not-available", { version: "0.1.0" })
    expect(updates.state()).toEqual({ status: "idle", currentVersion: "0.1.0", checkedAt: "2026-11-18T12:00:00.000Z" })
    await updates.check()
    emit("error", new Error("Could not get code signature\nstack"))
    expect(updates.state()).toMatchObject({ status: "error", message: "Could not get code signature" })
  })

  it("keeps a downloaded update ready through later checks and errors", async () => {
    const { emit, updater, updates } = setup()
    emit("update-downloaded", { version: "0.2.0" })
    await updates.check()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    emit("error", new Error("offline"))
    expect(updates.state().status).toBe("ready")
  })

  it("installs only a ready update, and only if preparation allows it", async () => {
    let allow = false
    const { emit, updater, updates } = setup(async () => allow)
    expect(await updates.install()).toBe(false)
    emit("update-downloaded", { version: "0.2.0" })
    expect(await updates.install()).toBe(false)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    allow = true
    expect(await updates.install()).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it("is inert in builds that cannot update", async () => {
    const updates = createUpdater({ currentVersion: "0.1.0", updater: null, unsupportedReason: "dev build", broadcast: () => {}, prepareInstall: async () => true })
    expect(updates.state()).toEqual({ status: "unsupported", currentVersion: "0.1.0", message: "dev build" })
    expect(await updates.check()).toMatchObject({ status: "unsupported" })
    expect(await updates.install()).toBe(false)
  })
})

describe("prepareDaemonForUpdate", () => {
  const connection = () => ({ url: "http://127.0.0.1:4317", token: "t" })
  const info = (body: object) => vi.fn(async () => new Response(JSON.stringify({ pid: 4242, persistent: false, activeSessions: 0, activeRuns: 0, ...body })))
  const processes = (exitAfterChecks = 2) => {
    const signals: Array<NodeJS.Signals | 0> = []
    let checks = 0
    const kill = (_pid: number, signal: NodeJS.Signals | 0) => {
      signals.push(signal)
      if (signal === 0 && ++checks > exitAfterChecks) throw new Error("ESRCH")
    }
    return { kill, signals }
  }
  const sleep = async () => {}

  it("stops an idle app-started daemon and waits for it to exit", async () => {
    const p = processes()
    const confirm = vi.fn(async () => true)
    expect(await prepareDaemonForUpdate({ connection, confirm, fetch: info({}), kill: p.kill, sleep })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(p.signals).toEqual(["SIGTERM", 0, 0, 0])
  })

  it("asks before interrupting running work and keeps the daemon if declined", async () => {
    const p = processes()
    const confirm = vi.fn(async () => false)
    expect(await prepareDaemonForUpdate({ connection, confirm, fetch: info({ activeSessions: 2, activeRuns: 1 }), kill: p.kill, sleep })).toBe(false)
    expect(confirm).toHaveBeenCalledWith({ sessions: 2, runs: 1 })
    expect(p.signals).toEqual([])
  })

  it("leaves a supervised service running", async () => {
    const p = processes()
    expect(await prepareDaemonForUpdate({ connection, confirm: async () => false, fetch: info({ persistent: true, activeRuns: 3 }), kill: p.kill, sleep })).toBe(true)
    expect(p.signals).toEqual([])
  })

  it("proceeds when no daemon is reachable", async () => {
    const p = processes()
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    expect(await prepareDaemonForUpdate({ connection, confirm: async () => false, fetch: down, kill: p.kill, sleep })).toBe(true)
    expect(await prepareDaemonForUpdate({ connection: () => undefined, confirm: async () => false, kill: p.kill, sleep })).toBe(true)
    expect(p.signals).toEqual([])
  })

  it("gives up waiting after the timeout", async () => {
    const p = processes(Number.POSITIVE_INFINITY)
    expect(await prepareDaemonForUpdate({ connection, confirm: async () => true, fetch: info({}), kill: p.kill, sleep, timeoutMs: 1000 })).toBe(true)
    expect(p.signals.filter((s) => s === 0)).toHaveLength(4)
  })
})
