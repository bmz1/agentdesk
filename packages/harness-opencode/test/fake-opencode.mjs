#!/usr/bin/env node
// Stand-in for OpenCode 2's `opencode serve --stdio`: the /api HTTP surface AgentDesk uses, its event bus,
// password auth, and the shapes a real 2.2 server returns (captured from one).
import { createServer } from "node:http"

const [cmd, ...args] = process.argv.slice(2)
if (cmd === "--version") {
  console.log("2.2.6")
  process.exit(0)
}
if (cmd === "models") {
  console.log("opencode/fake-free\nacme/big/model-1")
  process.exit(0)
}
if (cmd !== "serve" || !args.includes("--stdio")) process.exit(2)

const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD ?? ""}`).toString("base64")}`
const clients = new Set()
let seq = 0
const send = (type, data) => {
  const line = JSON.stringify({ id: `evt_${++seq}`, created: Date.now(), type, data })
  for (const res of clients) res.write(`data: ${line}\n\n`)
}
const sessions = new Map()
const info = (id, extra = {}) => ({
  id,
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1794997920126, updated: 1794997920126 },
  ...extra
})
let n = 0
let pending = null
const step = (S, m) => send("session.step.started", { sessionID: S, assistantMessageID: m, agent: "build", model: sessions.get(S).model ?? { id: "fake-free", providerID: "opencode" }, started: Date.now() })
const finish = (S, m) => {
  send("session.step.ended", { sessionID: S, assistantMessageID: m, finish: "stop", rawFinish: "stop", tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0.01, files: [] })
  send("session.execution.succeeded", { sessionID: S })
}
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b ? JSON.parse(b) : {})) })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  const json = (code, data) => { res.writeHead(code, { "content-type": "application/json" }); res.end(data === undefined ? "" : JSON.stringify(data)) }
  const empty = () => { res.writeHead(204); res.end() }
  if (req.headers.authorization !== auth) return json(401, { _tag: "UnauthorizedError", message: "Authentication required" })
  const p = url.pathname
  if (p === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream" })
    clients.add(res)
    res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`)
    req.on("close", () => clients.delete(res))
    return
  }
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {}
  if (req.method === "POST" && p === "/api/session") {
    const id = `ses_fake${sessions.size || ""}`
    sessions.set(id, { permissions: body.permissions, model: body.model, location: body.location })
    return json(200, { data: info(id, { title: body.title, permissions: body.permissions, location: body.location, ...(body.model && { model: body.model }) }) })
  }
  if (p === "/api/model" || p === "/api/model/default") return json(500, { _tag: "Unavailable", message: "no models here" })
  const m = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(p)
  if (!m) return json(404, {})
  const [, S, rest = ""] = m
  const s = sessions.get(S)
  if (!s) return json(404, { _tag: "SessionNotFoundError", message: "no session" })
  if (req.method === "GET" && rest === "") return json(200, { data: info(S, { permissions: s.permissions, location: s.location, ...(s.model && { model: s.model }) }) })
  if (req.method === "PATCH" && rest === "") {
    if (body.permissions) s.permissions = body.permissions
    return empty()
  }
  if (rest === "/model") {
    s.model = body.model
    send("session.model.selected", { sessionID: S, model: body.model })
    return empty()
  }
  if (rest.startsWith("/instructions") || p.includes("/instructions/")) return empty()
  if (rest === "/prompt") {
    const text = body.text
    const msg = `msg_${++n}`
    json(200, { data: { id: `msg_u${n}`, sessionID: S, time: { created: Date.now() }, type: "user", payload: { text }, delivery: "steer" } })
    send("session.execution.started", { sessionID: S })
    step(S, msg)
    // Events this client version doesn't know, and garbage, must not end the stream.
    send("session.step.first-token", { sessionID: S, assistantMessageID: msg })
    for (const res of clients) res.write("data: {not json\n\n")
    send("session.text.delta", { sessionID: S, assistantMessageID: msg, ordinal: 0, delta: "echo " })
    send("session.text.ended", { sessionID: S, assistantMessageID: msg, ordinal: 0, text: `echo ${text}` })
    if (text.includes("model?")) {
      send("session.text.ended", { sessionID: S, assistantMessageID: msg, ordinal: 1, text: `model ${JSON.stringify(s.model ?? null)} files ${(body.files ?? []).length}` })
      return finish(S, msg)
    }
    if (text.includes("tool")) {
      send("session.tool.input.started", { sessionID: S, assistantMessageID: msg, id: "c1", name: "shell" })
      send("session.tool.called", { sessionID: S, assistantMessageID: msg, id: "c1", input: { command: "ls" }, executed: false })
      pending = { S, msg }
      return send("permission.asked", { id: "per_1", sessionID: S, action: "shell", resources: ["ls"], save: ["ls *"], source: { type: "tool", messageID: msg, id: "c1" } })
    }
    if (text.includes("subagent")) {
      const child = "ses_child"
      sessions.set(child, { permissions: [] })
      send("session.created", { sessionID: child, parentID: S, projectID: "global", title: "explore" })
      // The child's text is the subagent's own business.
      send("session.text.ended", { sessionID: child, assistantMessageID: "msg_c", ordinal: 0, text: "child chatter" })
      pending = { S, msg }
      return send("permission.asked", { id: "per_child", sessionID: child, action: "webfetch", resources: ["https://example.com"], save: [] })
    }
    if (text.includes("form")) {
      pending = { S, msg }
      return send("form.created", {
        form: {
          id: "frm_1",
          sessionID: S,
          title: "Setup",
          fields: [
            { key: "indent", type: "string", title: "Indentation", description: "Tabs or spaces?", options: [{ value: "tab", label: "Tabs" }, { value: "space", label: "Spaces" }] },
            { key: "tests", type: "boolean", title: "Write tests?" }
          ]
        }
      })
    }
    if (!text.includes("hang")) finish(S, msg)
    return
  }
  const perm = /^\/permission\/([^/]+)\/reply$/.exec(rest)
  if (perm) {
    if (!pending) return json(404, { _tag: "PermissionNotFoundError", message: "none" })
    empty()
    send("permission.replied", { sessionID: S, requestID: perm[1], reply: body.decision })
    const ok = body.decision !== "reject"
    const { S: owner, msg } = pending
    pending = null
    const outcome = `${S}:${body.decision}${body.message ? `:${body.message}` : ""}`
    if (perm[1] === "per_child") {
      send("session.text.ended", { sessionID: owner, assistantMessageID: msg, ordinal: 1, text: `child permission ${outcome}` })
      return finish(owner, msg)
    }
    send(ok ? "session.tool.success" : "session.tool.failed", {
      sessionID: owner,
      assistantMessageID: msg,
      id: "c1",
      ...(ok ? { content: [{ type: "text", text: `file ${body.decision}` }] } : { error: { type: "rejected", message: "rejected by user" } }),
      executed: true
    })
    return finish(owner, msg)
  }
  const form = /^\/form\/([^/]+)\/(reply|cancel)$/.exec(rest)
  if (form || (req.method === "DELETE" && rest.startsWith("/form/"))) {
    empty()
    const { msg } = pending ?? { msg: "msg_x" }
    pending = null
    const answer = form?.[2] === "reply" ? JSON.stringify(body.answer) : "cancelled"
    send(form?.[2] === "reply" ? "form.replied" : "form.cancelled", { id: "frm_1", sessionID: S })
    send("session.text.ended", { sessionID: S, assistantMessageID: msg, ordinal: 1, text: `answered ${answer}` })
    return finish(S, msg)
  }
  if (rest === "/interrupt") {
    json(200, { interrupted: true })
    return send("session.execution.interrupted", { sessionID: S, reason: "user" })
  }
  json(404, {})
})

server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })))
// Like the real stdio server: serve until stdin closes.
process.stdin.on("end", () => process.exit(0))
process.stdin.resume()
process.on("SIGTERM", () => process.exit(0))
