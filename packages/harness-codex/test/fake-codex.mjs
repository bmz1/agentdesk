#!/usr/bin/env node
// Minimal stand-in for `codex app-server` (JSON-RPC over JSONL stdio).
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
if (process.argv[2] !== "app-server") process.exit(2)
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
let thread = null
let turnN = 0
let pendingApproval = null
const rl = createInterface({ input: process.stdin })
const finishTurn = (turnId, status = "completed") =>
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status, error: null, durationMs: 5 } } })
rl.on("line", (line) => {
  const m = JSON.parse(line)
  if (process.env.AGENTDESK_TEST_CODEX_LOG) appendFileSync(process.env.AGENTDESK_TEST_CODEX_LOG, JSON.stringify(m) + "\n")
  if (m.method === "initialize") return out({ id: m.id, result: { userAgent: "fake" } })
  if (m.method === "initialized") return
  if (m.method === "thread/start" || m.method === "thread/resume") {
    thread = m.params.threadId ?? "thr_fake"
    out({ id: m.id, result: { thread: { id: thread, model: "fake", cwd: m.params.cwd } } })
    if (m.method === "thread/start") out({ method: "thread/started", params: { thread: { id: thread, model: "fake" } } })
    return
  }
  if (m.method === "turn/start") {
    const turnId = `turn_${++turnN}`
    const text = m.params.input[0].text
    out({ id: m.id, result: { turn: { id: turnId, status: "inProgress" } } })
    out({ method: "turn/started", params: { threadId: thread, turn: { id: turnId } } })
    out({ method: "item/agentMessage/delta", params: { itemId: `m${turnN}`, delta: "echo " } })
    out({ method: "item/completed", params: { item: { type: "agentMessage", id: `m${turnN}`, text: "echo " + text } } })
    if (text.includes("cmd")) {
      out({ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "ls" } } })
      pendingApproval = { turnId }
      out({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId, itemId: "c1", command: "ls" } })
    } else if (!text.includes("hang")) finishTurn(turnId)
    return
  }
  if (m.method === "turn/interrupt") {
    out({ id: m.id, result: {} })
    return finishTurn(m.params.turnId, "interrupted")
  }
  if (m.id === 99 && m.result) {
    const ok = m.result.decision === "accept"
    out({ method: "item/completed", params: { item: { type: "commandExecution", id: "c1", aggregatedOutput: ok ? "file" : "", exitCode: ok ? 0 : 1, status: ok ? "completed" : "declined" } } })
    finishTurn(pendingApproval.turnId)
  }
})
rl.on("close", () => process.exit(0))
