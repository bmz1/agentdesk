import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeMockAdapter } from "@agentdesk/harness-core"
import { type RunningDaemon, startDaemon, type StartDaemonOptions } from "../src/server"

export const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdesk-repo-"))
  execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "# demo\n")
  execSync("git add . && git commit -qm init", { cwd: dir })
  return dir
}

export const startTestDaemon = async (opts: StartDaemonOptions = {}, dataDir = mkdtempSync(join(tmpdir(), "agentdesk-data-"))) => {
  const daemon = await startDaemon({
    adapters: [makeMockAdapter({ delayMs: 1 })],
    ...opts,
    config: { dataDir, port: 0, token: "test-token", enableSourcePolling: false, ...opts.config }
  })
  return { daemon, dataDir, api: makeClient(daemon) }
}

export const makeClient = (daemon: RunningDaemon, token = "test-token") => {
  const call = async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(daemon.url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    const json = text ? JSON.parse(text) : undefined
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${json?.message ?? text}`), { status: res.status, body: json })
    return json as T
  }
  return {
    get: <T = any>(p: string) => call<T>("GET", p),
    post: <T = any>(p: string, b?: unknown) => call<T>("POST", p, b ?? {}),
    patch: <T = any>(p: string, b: unknown) => call<T>("PATCH", p, b),
    del: <T = any>(p: string) => call<T>("DELETE", p),
    /** Collect SSE `data` payloads until `until` returns true. */
    sse: async (path: string, until: (events: Array<any>) => boolean, timeoutMs = 10_000) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(daemon.url + path, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal
      })
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      const events: Array<any> = []
      let buf = ""
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const ev = /^event: (.*)$/m.exec(chunk)?.[1]
            const data = /^data: (.*)$/m.exec(chunk)?.[1]
            if (data && ev !== "ready") events.push(JSON.parse(data))
          }
          if (until(events)) break
        }
      } catch (e) {
        if (!controller.signal.aborted) throw e
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
      return events
    }
  }
}

export const waitFor = async <T>(f: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await f()
    if (v !== undefined && v !== false) return v
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("waitFor timed out")
}
