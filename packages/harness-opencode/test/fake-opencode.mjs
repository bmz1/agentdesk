#!/usr/bin/env node
// Minimal stand-in for `opencode serve`: HTTP API + SSE event bus.
import { createServer } from "node:http"
if (process.argv[2] !== "serve") process.exit(2)
const clients = new Set()
const send = (type, properties) => {
  for (const res of clients) res.write(`data: ${JSON.stringify({ type, properties })}\n\n`)
}
const S = "ses_fake"
let n = 0
let pendingTurn = null
const finish = () => send("session.idle", { sessionID: S })
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})) })
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const json = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(data)) }
  if (url.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" })
    clients.add(res)
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
    req.on("close", () => clients.delete(res))
    return
  }
  const body = req.method === "POST" ? await readBody(req) : {}
  if (req.method === "POST" && url.pathname === "/session") return json(200, { id: S, permissionRules: body.permission })
  if (req.method === "GET" && url.pathname === `/session/${S}`) return json(200, { id: S })
  if (url.pathname === `/session/${S}/prompt_async`) {
    json(204, {})
    const text = body.parts[0].text
    const m = `msg_${++n}`
    send("message.updated", { sessionID: S, info: { id: `u${m}`, sessionID: S, role: "user" } })
    send("message.part.updated", { sessionID: S, part: { id: `pu${n}`, sessionID: S, messageID: `u${m}`, type: "text", text, time: { start: 1, end: 1 } } })
    send("message.updated", { sessionID: S, info: { id: m, sessionID: S, role: "assistant" } })
    send("message.part.delta", { sessionID: S, messageID: m, partID: `p${n}`, field: "text", delta: "echo " })
    send("message.part.updated", { sessionID: S, part: { id: `p${n}`, sessionID: S, messageID: m, type: "text", text: "echo " + text, time: { start: 1, end: 2 } } })
    if (text.includes("tool")) {
      send("message.part.updated", { sessionID: S, part: { id: "pt", sessionID: S, messageID: m, type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "ls" } } } })
      pendingTurn = m
      send("permission.asked", { id: "per_1", sessionID: S, permission: "bash", patterns: ["ls"], metadata: {}, always: [] })
    } else if (!text.includes("hang")) finish()
    return
  }
  if (url.pathname === "/permission/per_1/reply") {
    json(200, true)
    const ok = body.reply === "once"
    send("message.part.updated", { sessionID: S, part: { id: "pt", sessionID: S, messageID: pendingTurn, type: "tool", callID: "c1", tool: "bash", state: ok ? { status: "completed", input: {}, output: "file" } : { status: "error", input: {}, error: "rejected" } } })
    return finish()
  }
  if (url.pathname === `/session/${S}/abort`) {
    json(200, true)
    send("session.error", { sessionID: S, error: { name: "MessageAbortedError", data: {} } })
    return finish()
  }
  json(404, {})
})
server.listen(0, "127.0.0.1", () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`))
process.on("SIGTERM", () => process.exit(0))
