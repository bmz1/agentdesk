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
  if (m.method === "account/rateLimits/read") {
    return out({
      id: m.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1800000000 },
          secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: null },
          rateLimitReachedType: null
        }
      }
    })
  }
  if (m.method === "thread/start" || m.method === "thread/resume") {
    thread = m.params.threadId ?? "thr_fake"
    out({ id: m.id, result: { thread: { id: thread, model: "fake", cwd: m.params.cwd } } })
    if (m.method === "thread/start") out({ method: "thread/started", params: { thread: { id: thread, model: "fake" } } })
    return
  }
  if (m.method === "turn/start") {
    const turnId = `turn_${++turnN}`
    const text = m.params.input[0].text
    // "slowstart": the turn id arrives late, so an interrupt sent meanwhile has no id to use yet.
    if (text.includes("slowstart")) {
      setTimeout(() => {
        out({ id: m.id, result: { turn: { id: turnId, status: "inProgress" } } })
        out({ method: "turn/started", params: { threadId: thread, turn: { id: turnId } } })
      }, 300)
      return
    }
    out({ id: m.id, result: { turn: { id: turnId, status: "inProgress" } } })
    out({ method: "turn/started", params: { threadId: thread, turn: { id: turnId } } })
    if (text.includes("plan")) {
      out({
        method: "turn/plan/updated",
        params: {
          threadId: thread,
          turnId,
          explanation: null,
          plan: [
            { step: "Read", status: "completed" },
            { step: "Write", status: "inProgress" }
          ]
        }
      })
      const usage = (input, cached, output) => ({
        totalTokens: 0,
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0
      })
      out({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: thread,
          turnId,
          tokenUsage: { total: usage(1500, 1000, 70), last: usage(1500, 1000, 70), modelContextWindow: null }
        }
      })
    }
    if (text.includes("ask")) {
      pendingApproval = { turnId }
      return out({
        id: 98,
        method: "item/tool/requestUserInput",
        params: {
          threadId: thread,
          turnId,
          itemId: "q1",
          isBlocking: true,
          autoResolutionMs: null,
          questions: [
            {
              id: "db",
              header: "Database",
              question: "Which database?",
              isOther: true,
              isSecret: false,
              options: [{ label: "SQLite", description: "Embedded" }]
            }
          ]
        }
      })
    }
    if (text.includes("edit")) {
      pendingApproval = { turnId }
      return out({ id: 97, method: "item/fileChange/requestApproval", params: { threadId: thread, turnId, itemId: "f1", reason: null } })
    }
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
  if (m.id === 98 && m.result) {
    const answer = m.result.answers.db?.answers.join(", ") ?? "(none)"
    out({ method: "item/completed", params: { item: { type: "agentMessage", id: "answer", text: `answer: ${answer}` } } })
    return finishTurn(pendingApproval.turnId)
  }
  if (m.id === 97 && m.result) {
    out({ method: "item/completed", params: { item: { type: "agentMessage", id: "edit", text: `edit: ${m.result.decision}` } } })
    return finishTurn(pendingApproval.turnId)
  }
  if (m.id === 99 && m.result) {
    const ok = m.result.decision === "accept" || m.result.decision === "acceptForSession"
    out({
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: "c1",
          aggregatedOutput: ok ? "file" : "",
          exitCode: ok ? 0 : 1,
          status: ok ? "completed" : "declined"
        }
      }
    })
    finishTurn(pendingApproval.turnId)
  }
})
rl.on("close", () => process.exit(0))
