import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { NodeProcessLayer, parseJsonLine } from "@agentdesk/harness-core"
import { describe, expect, it, layer } from "@effect/vitest"
import { Effect, Exit, Stream } from "effect"
import { claudeApprovalResponse, ClaudeNormalizer, makeClaudeAdapter, parseClaudeModels, permissionFlags } from "../src"

describe("Claude model list", () => {
  const response = (models: Array<Record<string, unknown>>) =>
    [
      JSON.stringify({ type: "system", subtype: "hook_started" }),
      "not json",
      JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "x", response: { models } } })
    ].join("\n")

  it("uses the CLI's exact names and per-model effort levels, naming the default", () => {
    const parsed = parseClaudeModels(response([
      { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: ["low", "high", "max"] },
      { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" }
    ]))
    expect(parsed).toEqual({
      models: [
        { id: "opus", label: "Opus 5.5", efforts: ["low", "high", "max"] },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }
      ],
      defaultModel: "Opus 5.5"
    })
  })

  it("reports nothing when the CLI gives no model list, so detection falls back to the aliases", () => {
    expect(parseClaudeModels("")).toBeUndefined()
    expect(parseClaudeModels(response([]))).toBeUndefined()
  })
})

describe("Claude permission flags", () => {
  it("maps auto to Claude's classifier-reviewed auto mode", () => {
    expect(permissionFlags("auto")).toEqual(["--permission-mode", "auto"])
    expect(permissionFlags("accept_edits")).toEqual(["--permission-mode", "acceptEdits"])
    expect(permissionFlags("ask")).toEqual([])
  })
})

describe("ClaudeNormalizer", () => {
  it("normalizes a golden stream-json transcript", () => {
    const n = new ClaudeNormalizer()
    const lines = readFileSync(join(__dirname, "fixtures/turn.jsonl"), "utf8").split("\n")
    const events = lines.flatMap((l) => {
      const m = parseJsonLine(l)
      return m === undefined ? [] : n.push(m)
    })
    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "tool.started",
      "approval.requested",
      "tool.completed",
      "reasoning",
      "message.completed",
      "turn.completed"
    ])
    expect(n.providerSessionId).toBe("sess-1")
    expect(events.find((e) => e.type === "approval.requested")).toMatchObject({
      providerRequestId: "req-1",
      toolName: "Bash",
      summary: "Bash: Write hi"
    })
    expect(events.at(-1)).toMatchObject({ status: "success", costUsd: 0.01, summary: "DONE" })
  })

  it("maps error results to error turns", () => {
    expect(new ClaudeNormalizer().push({ type: "result", subtype: "error_max_turns", is_error: true })).toEqual([
      expect.objectContaining({ type: "turn.completed", status: "error" })
    ])
  })
})

describe("Claude questions, plans, approvals and usage (shapes from Claude Code 2.1)", () => {
  const ask = {
    type: "control_request",
    request_id: "q1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Do you prefer tabs or spaces?", header: "Indentation", options: [{ label: "Tabs", description: "Indent with tab characters" }, { label: "Spaces" }], multiSelect: false }] },
      tool_use_id: "toolu_1",
      requires_user_interaction: true
    }
  }

  it("turns AskUserQuestion into a question and answers through updatedInput", () => {
    const [e] = new ClaudeNormalizer().push(ask)
    expect(e).toMatchObject({
      type: "approval.requested",
      kind: "question",
      summary: "Do you prefer tabs or spaces?",
      questions: [{ id: "Do you prefer tabs or spaces?", header: "Indentation", multiSelect: false, allowOther: true, options: [{ label: "Tabs" }, { label: "Spaces" }] }]
    })
    const pending = { toolName: "AskUserQuestion", input: ask.request.input, suggestions: [] }
    expect(claudeApprovalResponse(pending, { decision: "allow", answers: { "Do you prefer tabs or spaces?": ["Spaces"] } })).toEqual({
      behavior: "allow",
      updatedInput: { ...ask.request.input, answers: { "Do you prefer tabs or spaces?": "Spaces" } }
    })
    expect(claudeApprovalResponse(pending, { decision: "deny" })).toMatchObject({ behavior: "deny", message: "The user chose not to answer." })
  })

  it("allows for the session with Claude's own permission suggestions", () => {
    const suggestions = [{ type: "setMode", mode: "acceptEdits", destination: "session" }]
    const [e] = new ClaudeNormalizer().push({
      type: "control_request",
      request_id: "w1",
      request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "a", content: "hi" }, description: "probe.txt", permission_suggestions: suggestions }
    })
    expect(e).toMatchObject({ type: "approval.requested", canAllowForSession: true, summary: "Write: probe.txt" })
    const pending = { toolName: "Write", input: { file_path: "a" }, suggestions }
    expect(claudeApprovalResponse(pending, { decision: "allow", scope: "session" })).toEqual({ behavior: "allow", updatedInput: { file_path: "a" }, updatedPermissions: suggestions })
    expect(claudeApprovalResponse(pending, { decision: "allow" })).toEqual({ behavior: "allow", updatedInput: { file_path: "a" } })
  })

  it("reports per-turn cost from the cumulative total, usage, model and interrupts", () => {
    const n = new ClaudeNormalizer()
    const result = (cost: number, extra: Record<string, unknown> = {}) => ({
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: cost,
      usage: { input_tokens: 4, cache_creation_input_tokens: 8456, cache_read_input_tokens: 40578, output_tokens: 151, output_tokens_details: { thinking_tokens: 0 } },
      modelUsage: { "claude-opus-5-5": {} },
      ...extra
    })
    expect(n.push(result(0.0788))[0]).toMatchObject({
      status: "success",
      costUsd: 0.0788,
      model: "claude-opus-5-5",
      usage: { inputTokens: 4, outputTokens: 151, cacheReadTokens: 40578, cacheWriteTokens: 8456 }
    })
    expect(n.push(result(0.0977))[0]).toMatchObject({ costUsd: 0.0189 })
    expect(n.push(result(0.1, { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }))[0]).toMatchObject({ status: "interrupted" })
    n.interruptRequested = true
    expect(n.push(result(0.1, { subtype: "error_during_execution", is_error: true }))[0]).toMatchObject({ status: "interrupted" })
    expect(n.push(result(0.1, { subtype: "error_max_turns", is_error: true }))[0]).toMatchObject({ status: "error" })
  })

  it("reads rate limits and plans from TodoWrite and the Task tools", () => {
    const n = new ClaudeNormalizer()
    expect(
      n.push({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.11, resetsAt: 1794973200 }, seven_day: { utilization: 0.61, resetsAt: 1795276800 } } }
      })
    ).toEqual([
      {
        type: "rate_limit",
        limited: false,
        windows: [
          { id: "five_hour", label: "5-hour", usedPercent: 11, resetsAt: new Date(1794973200 * 1000).toISOString() },
          { id: "seven_day", label: "Weekly", usedPercent: 61, resetsAt: new Date(1795276800 * 1000).toISOString() }
        ]
      }
    ])
    const toolUse = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { id: "m", content: [{ type: "tool_use", id, name, input }] } })
    const toolResult = (id: string, content: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } })
    expect(n.push(toolUse("t0", "TodoWrite", { todos: [{ content: "Read", status: "completed", activeForm: "Reading" }, { content: "Write", status: "in_progress" }] }))[1]).toEqual({
      type: "plan.updated",
      items: [{ text: "Read", status: "completed" }, { text: "Write", status: "in_progress" }]
    })
    n.push(toolUse("t1", "TaskCreate", { subject: "Write notes" }))
    expect(n.push(toolResult("t1", "Task #1 created successfully: Write notes")).at(-1)).toEqual({ type: "plan.updated", items: [{ text: "Write notes", status: "pending" }] })
    expect(n.push(toolUse("t2", "TaskUpdate", { taskId: "1", status: "in_progress" })).at(-1)).toEqual({ type: "plan.updated", items: [{ text: "Write notes", status: "in_progress" }] })
  })
})

layer(NodeProcessLayer, { excludeTestServices: true })("Claude adapter (fake CLI process)", (it) => {
  const adapter = makeClaudeAdapter({ binary: join(__dirname, "fake-claude.mjs") })

  it.effect("streams a turn, round-trips an approval and accepts a follow-up", () =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" }, prompt: "use a tool" })
      const seen: Array<AgentEvent> = []
      let turns = 0
      yield* session.events.pipe(
        Stream.tap((e) =>
          Effect.gen(function* () {
            seen.push(e)
            if (e.type === "approval.requested") yield* session.respondToApproval(e.providerRequestId!, { decision: "allow" })
            if (e.type === "turn.completed" && ++turns === 1) yield* session.prompt("second")
          })
        ),
        Stream.takeUntil((e) => e.type === "turn.completed" && turns >= 2),
        Stream.runDrain
      )
      expect(yield* session.providerSessionId).toBe("fake-session")
      expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2)
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ isError: false, result: "ok" })
    })
  )

  it.effect("answers control requests it does not serve, so Claude never waits on them", () =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" }, prompt: "run a hook" })
      const turn = yield* session.events.pipe(
        Stream.filter((e) => e.type === "turn.completed"),
        Stream.runHead
      )
      expect(turn._tag === "Some" && turn.value).toMatchObject({ type: "turn.completed", summary: "hook error" })
    })
  )

  it.effect("fails with a typed not_installed error for a missing binary", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(makeClaudeAdapter({ binary: "/nonexistent/claude" }).start({ cwd: tmpdir(), policy: { permissionMode: "ask" } }))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = yield* Effect.flip(makeClaudeAdapter({ binary: "/nonexistent/claude" }).start({ cwd: tmpdir(), policy: { permissionMode: "ask" } }))
      expect(error).toMatchObject({ _tag: "HarnessError", reason: "not_installed" })
    })
  )
})

describe("ClaudeNormalizer images", () => {
  it("splits screenshots out of tool results into image events", () => {
    const n = new ClaudeNormalizer()
    const events = n.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "Took a screenshot" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
            ]
          }
        ]
      }
    })
    expect(events).toEqual([
      { type: "tool.completed", toolCallId: "t1", result: "Took a screenshot", isError: false },
      { type: "image", toolCallId: "t1", source: { data: "AAAA", mimeType: "image/png" } }
    ])
  })
})
