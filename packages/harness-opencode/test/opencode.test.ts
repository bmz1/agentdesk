import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { type HarnessSession, NodeProcessLayer, parseJsonLine } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { describe, expect, it, layer } from "@effect/vitest"
import { makeOpenCodeAdapter, openCodeAnswers, openCodeModel, OpenCodeNormalizer, openCodePermissions, parseVerboseModels } from "../src"

describe("OpenCodeNormalizer", () => {
  it("normalizes a golden event-bus transcript for one session", () => {
    const n = new OpenCodeNormalizer("ses_1")
    n.markBusy()
    const events = readFileSync(join(__dirname, "fixtures/events.jsonl"), "utf8")
      .split("\n")
      .flatMap((l) => {
        const m = parseJsonLine(l)
        return m === undefined ? [] : n.push(m)
      })
    expect(events.map((e) => e.type)).toEqual([
      "message.delta",
      "message.delta",
      "message.completed",
      "tool.started",
      "approval.requested",
      "tool.completed",
      "turn.completed"
    ])
    expect(events[4]).toMatchObject({ providerRequestId: "per_1", summary: "bash: ls" })
    expect(events.at(-1)).toMatchObject({ status: "success", providerSessionId: "ses_1" })
  })

  it("maps policies to permission rules", () => {
    expect(openCodePermissions("accept_edits")).toContainEqual({ permission: "edit", pattern: "*", action: "allow" })
    expect(openCodePermissions("plan")).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
  })
})

layer(NodeProcessLayer, { excludeTestServices: true })("OpenCode adapter (fake server)", (it) => {
  const adapter = makeOpenCodeAdapter({ binary: join(__dirname, "fake-opencode.mjs"), startupTimeoutMs: 10_000 })
  const run = (prompt: string, onEvent: (e: AgentEvent, s: HarnessSession) => Effect.Effect<void, unknown>, turns: number) =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" }, prompt })
      const seen: Array<AgentEvent> = []
      let done = 0
      yield* session.events.pipe(
        Stream.tap((e) => {
          seen.push(e)
          if (e.type === "turn.completed") done++
          return onEvent(e, session)
        }),
        Stream.takeUntil(() => done >= turns),
        Stream.runDrain
      )
      return seen
    })

  it.effect("streams, round-trips permissions and accepts follow-ups", () =>
    Effect.gen(function* () {
      const seen = yield* run(
        "use tool",
        (e, s) =>
          Effect.gen(function* () {
            if (e.type === "approval.requested") yield* s.respondToApproval(e.providerRequestId!, { decision: "allow" })
            if (e.type === "turn.completed" && e.status === "success") yield* s.prompt("again")
          }),
        2
      )
      expect(seen[0]).toMatchObject({ type: "session.started", providerSessionId: "ses_fake" })
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ result: "file", isError: false })
      expect(seen.filter((e) => e.type === "message.completed").map((e) => (e as { text: string }).text)).toEqual([
        "echo use tool",
        "echo again"
      ])
    })
  )

  it.effect("interrupts via abort", () =>
    Effect.gen(function* () {
      const seen = yield* run("hang", (e, s) => (e.type === "message.completed" ? s.interrupt : Effect.void), 1)
      expect(seen.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" })
    })
  )
})

describe("OpenCodeNormalizer errors", () => {
  it("reports a failed turn when the session errored before going idle", () => {
    const n = new OpenCodeNormalizer("s")
    n.markBusy()
    n.push({ type: "session.error", properties: { sessionID: "s", error: { name: "ProviderAuthError", data: { message: "no key" } } } })
    expect(n.push({ type: "session.idle", properties: { sessionID: "s" } })).toEqual([
      { type: "turn.completed", providerSessionId: "s", status: "error", durationMs: expect.any(Number) }
    ])
  })
})

describe("OpenCode questions, plans, approvals and usage (shapes from opencode 1.19)", () => {
  const ev = (type: string, properties: Record<string, unknown>) => ({ type, properties: { sessionID: "s", ...properties } })

  it("turns a question into a question request and answers in question order", () => {
    const n = new OpenCodeNormalizer("s")
    const [asked] = n.push(
      ev("question.asked", {
        id: "que_1",
        questions: [{ question: "Tabs or spaces?", header: "Indentation", options: [{ label: "Tabs", description: "Indent with tabs" }, { label: "Spaces", description: "Indent with spaces" }] }]
      })
    )
    expect(asked).toMatchObject({
      type: "approval.requested",
      kind: "question",
      providerRequestId: "que_1",
      summary: "Tabs or spaces?",
      questions: [{ id: "0", header: "Indentation", question: "Tabs or spaces?", multiSelect: false, allowOther: true, options: [{ label: "Tabs" }, { label: "Spaces" }] }]
    })
    expect(n.questionIds.has("que_1")).toBe(true)
    expect(openCodeAnswers({ "1": ["b"], "0": ["Spaces"] })).toEqual({ answers: [["Spaces"], ["b"]] })
  })

  it("offers allow-for-session when OpenCode proposes an `always` pattern", () => {
    const n = new OpenCodeNormalizer("s")
    const [asked] = n.push(ev("permission.asked", { id: "per_1", permission: "bash", patterns: ["echo oc-one"], metadata: { command: "echo oc-one" }, always: ["echo *"] }))
    expect(asked).toMatchObject({ type: "approval.requested", toolName: "bash", summary: "bash: echo oc-one", canAllowForSession: true })
  })

  it("maps todos to a plan", () => {
    const n = new OpenCodeNormalizer("s")
    expect(
      n.push(ev("todo.updated", { todos: [{ content: "First task", status: "in_progress", priority: "high" }, { content: "Second task", status: "pending", priority: "medium" }] }))
    ).toEqual([{ type: "plan.updated", items: [{ text: "First task", status: "in_progress" }, { text: "Second task", status: "pending" }] }])
  })

  it("sums the turn's assistant messages into usage, cost and model", () => {
    const n = new OpenCodeNormalizer("s")
    n.markBusy()
    const message = (id: string, input: number, output: number, read: number, cost: number) =>
      ev("message.updated", {
        info: { id, role: "assistant", sessionID: "s", cost, providerID: "opencode", modelID: "deepseek-v4.1-flash-free", time: { created: 1, completed: 2 }, tokens: { total: 0, input, output, reasoning: 0, cache: { write: 0, read } } }
      })
    n.push(message("m1", 10193, 92, 1792, 0.01))
    n.push(message("m1", 10193, 92, 1792, 0.01)) // updates repeat
    n.push(message("m2", 211, 4, 11904, 0.02))
    const [turn] = n.push(ev("session.idle", {}))
    expect(turn).toMatchObject({
      type: "turn.completed",
      status: "success",
      costUsd: 0.03,
      model: "opencode/deepseek-v4.1-flash-free",
      usage: { inputTokens: 10404, outputTokens: 96, cacheReadTokens: 13696, cacheWriteTokens: 0 }
    })
  })
})

describe("parseVerboseModels", () => {
  it("reads each model's variants as its effort levels", () => {
    const out = ["opencode/a-free", "{", '  "id": "a-free",', '  "variants": { "low": {}, "high": {} }', "}", "openai/gpt-x", "{", '  "variants": {}', "}"].join("\n")
    expect(parseVerboseModels(out)).toEqual([
      { id: "opencode/a-free", label: "a-free", provider: "opencode", efforts: ["low", "high"] },
      { id: "openai/gpt-x", label: "gpt-x", provider: "openai" }
    ])
  })
})

describe("openCodeModel", () => {
  it("splits provider/model at the first slash", () => {
    expect(openCodeModel("openrouter/anthropic/claude-x")).toEqual({ providerID: "openrouter", modelID: "anthropic/claude-x" })
    expect(openCodeModel("no-provider")).toBeUndefined()
    expect(openCodeModel(undefined)).toBeUndefined()
  })
})
