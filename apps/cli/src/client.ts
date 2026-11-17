import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Stable exit codes: scripts and agents branch on these, so never renumber them. */
export const Exit = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** The target does not exist or matches more than one thing. */
  target: 3,
  /** No daemon is running or it refused the token. */
  unreachable: 4,
  /** The agent stopped to wait for an approval. */
  blocked: 5,
  interrupted: 130
} as const

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly details?: unknown
  ) {
    super(message)
  }
}

export interface Connection {
  readonly url: string
  readonly token: string
}

export const dataDir = (env: NodeJS.ProcessEnv = process.env) => env.AGENTDESK_HOME ?? join(homedir(), ".agentdesk")

/** `AGENTDESK_URL` + `AGENTDESK_TOKEN` win; otherwise the daemon's own discovery file. */
export const discover = (env: NodeJS.ProcessEnv = process.env): Connection => {
  if (env.AGENTDESK_URL && env.AGENTDESK_TOKEN) return { url: env.AGENTDESK_URL, token: env.AGENTDESK_TOKEN }
  const file = join(dataDir(env), "daemon.json")
  if (!existsSync(file)) {
    throw new CliError(`No AgentDesk daemon found (${file} is missing). Start the app or \`pnpm dev:daemon\`.`, Exit.unreachable)
  }
  try {
    const conn = JSON.parse(readFileSync(file, "utf8")) as Partial<Connection>
    if (!conn.url || !conn.token) throw new Error("incomplete")
    return { url: conn.url, token: conn.token }
  } catch {
    throw new CliError(`Unreadable daemon discovery file: ${file}`, Exit.unreachable)
  }
}

export interface Client {
  readonly get: <T>(path: string) => Promise<T>
  readonly post: <T>(path: string, body?: unknown) => Promise<T>
  /** Server-sent events as parsed `data` payloads; ends when `signal` aborts. */
  readonly stream: (path: string, signal: AbortSignal) => AsyncGenerator<{ event?: string; data: string }>
}

export const makeClient = (conn: Connection, fetchImpl: typeof fetch = fetch): Client => {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response
    try {
      res = await fetchImpl(conn.url + path, {
        method,
        headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    } catch (e) {
      throw new CliError(`AgentDesk daemon unreachable at ${conn.url}: ${(e as Error).message}`, Exit.unreachable)
    }
    const text = await res.text()
    const json = text ? (JSON.parse(text) as { message?: string }) : undefined
    if (res.status === 401) throw new CliError("The daemon rejected the token. Restart the app or check AGENTDESK_HOME.", Exit.unreachable)
    if (res.status === 404) throw new CliError(json?.message ?? `Not found: ${path}`, Exit.target)
    if (!res.ok) throw new CliError(json?.message ?? `${res.status} ${res.statusText}`, Exit.failed, json)
    return json as T
  }

  async function* stream(path: string, signal: AbortSignal) {
    let res: Response
    try {
      res = await fetchImpl(conn.url + path, {
        headers: { authorization: `Bearer ${conn.token}`, accept: "text/event-stream" },
        signal
      })
    } catch (e) {
      if (signal.aborted) return
      throw new CliError(`AgentDesk daemon unreachable at ${conn.url}: ${(e as Error).message}`, Exit.unreachable)
    }
    if (res.status === 404) throw new CliError(`Not found: ${path}`, Exit.target)
    if (!res.ok || !res.body) throw new CliError(`Event stream failed: ${res.status}`, Exit.failed)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
        let idx: number
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          let event: string | undefined
          const data: Array<string> = []
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim()
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
          }
          if (data.length && event !== "ready") yield { ...(event && { event }), data: data.join("\n") }
        }
      }
    } catch (e) {
      if (!signal.aborted) throw e
    } finally {
      reader.releaseLock()
    }
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body ?? {}),
    stream
  }
}
