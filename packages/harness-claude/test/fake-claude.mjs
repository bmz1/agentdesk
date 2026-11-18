#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json ...` used in adapter tests.
import { createInterface } from "node:readline"
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
const sid = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "fake-session"
let inited = false
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const msg = JSON.parse(line)
  if (msg.type === "control_request" && msg.request.subtype === "initialize") {
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {} } })
    return
  }
  if (msg.type === "control_request" && msg.request.subtype === "interrupt") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sid })
    return
  }
  if (msg.type === "control_response" && msg.response.request_id === "hook-1") {
    // The client answered the request it does not handle: the turn can finish.
    out({ type: "result", subtype: "success", is_error: false, result: `hook ${msg.response.subtype}`, session_id: sid, total_cost_usd: 0 })
    return
  }
  if (msg.type === "control_response") {
    const behavior = msg.response.response.behavior
    out({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: behavior === "allow" ? "ok" : "denied", is_error: behavior !== "allow" }
        ]
      },
      session_id: sid,
      parent_tool_use_id: null
    })
    out({
      type: "assistant",
      message: { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Finished" }] },
      session_id: sid,
      parent_tool_use_id: null
    })
    out({ type: "result", subtype: "success", is_error: false, result: "Finished", session_id: sid, total_cost_usd: 0 })
    return
  }
  if (msg.type === "user") {
    if (!inited) {
      out({ type: "system", subtype: "init", session_id: sid, cwd: process.cwd(), model: "fake" })
      inited = true
    }
    const text = msg.message.content[0].text
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Echo: " } },
      session_id: sid,
      parent_tool_use_id: null,
      api_message_id: "msg_1"
    })
    out({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      session_id: sid,
      parent_tool_use_id: null,
      api_message_id: "msg_1"
    })
    out({
      type: "assistant",
      message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Echo: " + text }] },
      session_id: sid,
      parent_tool_use_id: null
    })
    if (text.includes("hook")) {
      // A request type AgentDesk does not serve; the real CLI would wait for the answer forever.
      out({ type: "control_request", request_id: "hook-1", request: { subtype: "hook_callback", callback_id: "x", input: {} } })
    } else if (text.includes("tool")) {
      out({
        type: "assistant",
        message: { id: "msg_1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
        session_id: sid,
        parent_tool_use_id: null
      })
      out({
        type: "control_request",
        request_id: "req-1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1" }
      })
    } else {
      out({ type: "result", subtype: "success", is_error: false, result: "Echo: " + text, session_id: sid, total_cost_usd: 0 })
    }
  }
})
rl.on("close", () => process.exit(0))
