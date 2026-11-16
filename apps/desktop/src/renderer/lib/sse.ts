import { getConnection } from "./api"

export interface SseMessage {
  id?: string
  event?: string
  data: string
}

/**
 * Fetch-based SSE client (EventSource can't send an Authorization header).
 * Reconnects with backoff and resumes from the last seen event id.
 */
export const subscribeSse = (
  path: (lastId: string | undefined) => string,
  onMessage: (m: SseMessage) => void,
  opts: { onStatus?: (connected: boolean) => void } = {}
) => {
  let stopped = false
  let controller: AbortController | undefined
  let lastId: string | undefined
  let attempt = 0

  const loop = async () => {
    while (!stopped) {
      const conn = getConnection()
      if (!conn) {
        await sleep(1000)
        continue
      }
      controller = new AbortController()
      try {
        const res = await fetch(conn.url + path(lastId), {
          headers: { Authorization: `Bearer ${conn.token}`, Accept: "text/event-stream" },
          signal: controller.signal
        })
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`)
        opts.onStatus?.(true)
        attempt = 0
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ""
        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
          let idx: number
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const msg: SseMessage = { data: "" }
            const data: Array<string> = []
            for (const line of raw.split("\n")) {
              if (line.startsWith(":")) continue
              const colon = line.indexOf(":")
              const field = colon === -1 ? line : line.slice(0, colon)
              const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "")
              if (field === "id") msg.id = value
              else if (field === "event") msg.event = value
              else if (field === "data") data.push(value)
            }
            msg.data = data.join("\n")
            if (msg.id) lastId = msg.id
            if (msg.event !== "ready" && (msg.data || msg.event)) onMessage(msg)
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      opts.onStatus?.(false)
      if (stopped) break
      attempt++
      await sleep(Math.min(10_000, 300 * 2 ** Math.min(attempt, 5)))
    }
  }
  void loop()
  return () => {
    stopped = true
    controller?.abort()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
