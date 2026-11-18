import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { type HarnessSession, NodeProcessLayer } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { describe, expect, it, layer } from "@effect/vitest"
import {
  formAnswer,
  formQuestions,
  makeOpenCodeAdapter,
  openCodeModel,
  OpenCodeNormalizer,
  openCodePermissions,
  parseEvent,
  parseModelLines,
  parseModels,
  type PermissionRule
} from "../src"

/** OpenCode decides with the last rule matching the action and resource (as `Permission.evaluate` does). */
const evaluate = (rules: ReadonlyArray<PermissionRule>, action: string, resource = "x") => {
  const glob = (pattern: string, value: string) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(value)
  return rules.findLast((r) => glob(r.action, action) && glob(r.resource, resource))?.effect ?? "ask"
}

describe("permission rulesets", () => {
  it("ask: reads, searches and questions run; edits, shell, web and outside files ask", () => {
    const r = openCodePermissions("ask")
    for (const a of ["read", "grep", "glob", "question"]) expect(evaluate(r, a)).toBe("allow")
    for (const a of ["edit", "shell", "webfetch", "external_directory", "subagent"]) expect(evaluate(r, a)).toBe("ask")
    expect(evaluate(r, "read", "app/.env")).toBe("ask")
    expect(evaluate(r, "read", ".env.example")).toBe("allow")
  })

  it("accept_edits allows edits; shell still asks", () => {
    const r = openCodePermissions("accept_edits")
    expect(evaluate(r, "edit")).toBe("allow")
    expect(evaluate(r, "shell")).toBe("ask")
  })

  it("auto allows edits, web lookups and subagents; shell still asks", () => {
    const r = openCodePermissions("auto")
    for (const a of ["edit", "webfetch", "websearch", "subagent"]) expect(evaluate(r, a)).toBe("allow")
    expect(evaluate(r, "shell")).toBe("ask")
  })

  it("plan denies edits and shell commands (which hides their tools) but keeps reading", () => {
    const r = openCodePermissions("plan")
    expect(evaluate(r, "edit")).toBe("deny")
    expect(evaluate(r, "shell")).toBe("deny")
    expect(evaluate(r, "read")).toBe("allow")
  })

  it("unrestricted allows everything", () => {
    expect(evaluate(openCodePermissions("unrestricted"), "shell")).toBe("allow")
  })
})

describe("models", () => {
  it("splits provider/model at the first slash and carries the effort as the variant", () => {
    expect(openCodeModel("openrouter/anthropic/claude-x", "high")).toEqual({
      providerID: "openrouter",
      id: "anthropic/claude-x",
      variant: "high"
    })
    expect(openCodeModel("no-provider")).toBeUndefined()
    expect(openCodeModel(undefined)).toBeUndefined()
  })

  it("lists models with their variants as effort levels, skipping disabled and deprecated ones", () => {
    const model = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      modelID: id,
      providerID: "opencode",
      name: id.toUpperCase(),
      variants: [],
      enabled: true,
      status: "active",
      ...extra
    })
    expect(
      parseModels([
        model("hy4-flash-free", {
          name: "Hy4 flash Free",
          variants: [
            { id: "none", settings: {} },
            { id: "high", settings: {} }
          ]
        }),
        model("old", { status: "deprecated" }),
        model("off", { enabled: false })
      ])
    ).toEqual([{ id: "opencode/hy4-flash-free", label: "Hy4 flash Free", provider: "opencode", efforts: ["none", "high"] }])
    expect(parseModelLines("opencode-go/glm-5.2\nacme/big/model-1\n\nnot a model")).toEqual([
      { id: "opencode-go/glm-5.2", label: "glm-5.2", provider: "opencode-go" },
      { id: "acme/big/model-1", label: "big/model-1", provider: "acme" }
    ])
  })
})

describe("forms", () => {
  const form = {
    id: "frm_1",
    sessionID: "s",
    title: "Setup",
    fields: [
      {
        key: "indent",
        type: "string",
        title: "Indentation",
        description: "Tabs or spaces?",
        options: [
          { value: "tab", label: "Tabs" },
          { value: "space", label: "Spaces" }
        ]
      },
      { key: "name", type: "string", title: "Branch name" },
      { key: "tests", type: "boolean", title: "Write tests?" },
      {
        key: "langs",
        type: "multiselect",
        title: "Languages",
        options: [
          { value: "ts", label: "TypeScript" },
          { value: "go", label: "Go" }
        ],
        custom: true
      },
      { key: "count", type: "integer", title: "How many?" },
      { key: "secret", type: "string", hidden: true }
    ]
  }

  it("asks one question per visible field", () => {
    expect(formQuestions(form)).toEqual([
      {
        id: "indent",
        header: "Indentation",
        question: "Tabs or spaces?",
        options: [{ label: "Tabs" }, { label: "Spaces" }],
        multiSelect: false,
        allowOther: false
      },
      { id: "name", question: "Branch name", options: [], multiSelect: false, allowOther: true },
      { id: "tests", question: "Write tests?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false, allowOther: false },
      { id: "langs", question: "Languages", options: [{ label: "TypeScript" }, { label: "Go" }], multiSelect: true, allowOther: true },
      { id: "count", question: "How many?", options: [], multiSelect: false, allowOther: true }
    ])
  })

  it("answers with option values and typed values", () => {
    expect(formAnswer(form, { indent: ["Spaces"], name: ["fix/x"], tests: ["No"], langs: ["Go", "Rust"], count: ["3.7"] })).toEqual({
      indent: "space",
      name: "fix/x",
      tests: false,
      langs: ["go", "Rust"],
      count: 3
    })
  })
})

describe("OpenCodeNormalizer (OpenCode 2 events)", () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ type, data: { sessionID: "s", ...data } })

  it("skips unknown and malformed events instead of failing", () => {
    expect(parseEvent("{not json")).toBeUndefined()
    expect(parseEvent(JSON.stringify({ type: "session.step.first-token", data: { sessionID: "s" } }))).toEqual({
      type: "session.step.first-token",
      data: { sessionID: "s" }
    })
    expect(new OpenCodeNormalizer("s").push(ev("session.step.first-token", {}))).toEqual([])
  })

  it("normalizes a turn: text, tools, permission, usage summed over steps", () => {
    const n = new OpenCodeNormalizer("s")
    const out = [
      ev("session.execution.started", {}),
      ev("session.step.started", { assistantMessageID: "m1", model: { id: "hy4", providerID: "opencode" } }),
      ev("session.text.delta", { assistantMessageID: "m1", ordinal: 0, delta: "I'll " }),
      ev("session.text.ended", { assistantMessageID: "m1", ordinal: 0, text: "I'll look." }),
      ev("session.tool.input.started", { assistantMessageID: "m1", id: "t1", name: "shell" }),
      ev("session.tool.called", { assistantMessageID: "m1", id: "t1", input: { command: "ls" }, executed: false }),
      ev("permission.asked", { id: "per_1", action: "shell", resources: ["ls"], save: ["ls *"] }),
      ev("session.tool.success", { assistantMessageID: "m1", id: "t1", content: [{ type: "text", text: "a.txt\n" }], executed: true }),
      ev("session.step.ended", {
        assistantMessageID: "m1",
        tokens: { input: 100, output: 5, reasoning: 2, cache: { read: 10, write: 0 } },
        cost: 0.01
      }),
      ev("session.step.ended", {
        assistantMessageID: "m2",
        tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 20, write: 1 } },
        cost: 0.02
      }),
      ev("session.execution.succeeded", {})
    ].flatMap((e) => n.push(e))
    expect(out.map((e) => e.type)).toEqual([
      "message.delta",
      "message.completed",
      "tool.started",
      "approval.requested",
      "tool.completed",
      "turn.completed"
    ])
    expect(out[2]).toMatchObject({ toolCallId: "t1", name: "shell", input: { command: "ls" } })
    expect(out[3]).toMatchObject({ providerRequestId: "per_1", toolName: "shell", summary: "shell: ls", canAllowForSession: true })
    expect(out[4]).toMatchObject({ result: "a.txt\n", isError: false })
    expect(out[5]).toMatchObject({
      status: "success",
      model: "opencode/hy4",
      costUsd: 0.03,
      usage: { inputTokens: 150, outputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 1, reasoningTokens: 2 }
    })
    expect(n.pending.get("per_1")).toEqual({ kind: "permission", sessionID: "s" })
  })

  it("reports failures and interruptions as the turn's status", () => {
    const n = new OpenCodeNormalizer("s")
    expect(n.push(ev("session.execution.failed", { error: { type: "auth", message: "no key" } }))).toMatchObject([
      { type: "session.error", message: "no key" },
      { type: "turn.completed", status: "error" }
    ])
    expect(n.push(ev("session.execution.interrupted", { reason: "user" }))).toMatchObject([
      { type: "turn.completed", status: "interrupted" }
    ])
  })

  it("surfaces a subagent's permission requests but not its chatter, and ignores other sessions", () => {
    const n = new OpenCodeNormalizer("s")
    expect(n.push({ type: "session.created", data: { sessionID: "child", parentID: "s" } })).toEqual([])
    expect(n.push({ type: "session.text.ended", data: { sessionID: "child", assistantMessageID: "x", ordinal: 0, text: "hi" } })).toEqual(
      []
    )
    expect(
      n.push({ type: "permission.asked", data: { id: "per_c", sessionID: "child", action: "webfetch", resources: ["u"], save: [] } })
    ).toMatchObject([{ type: "approval.requested", canAllowForSession: false, details: { subagentSession: "child" } }])
    expect(n.pending.get("per_c")?.sessionID).toBe("child")
    expect(n.push({ type: "permission.asked", data: { id: "per_o", sessionID: "other", action: "shell", resources: [] } })).toEqual([])
  })

  it("turns a form into a question request", () => {
    const n = new OpenCodeNormalizer("s")
    const [asked] = n.push({
      type: "form.created",
      data: { form: { id: "frm_1", sessionID: "s", title: "Q", fields: [{ key: "k", type: "boolean", title: "Ship it?" }] } }
    })
    expect(asked).toMatchObject({
      type: "approval.requested",
      kind: "question",
      providerRequestId: "frm_1",
      summary: "Ship it?",
      questions: [{ id: "k" }]
    })
    expect(n.pending.get("frm_1")?.kind).toBe("form")
  })

  it("maps the todo tool to a plan", () => {
    const n = new OpenCodeNormalizer("s")
    n.push(ev("session.tool.input.started", { id: "t", name: "todowrite" }))
    expect(
      n.push(
        ev("session.tool.called", {
          id: "t",
          input: {
            todos: [
              { content: "First", status: "in_progress" },
              { content: "Second", status: "nope" }
            ]
          }
        })
      )
    ).toContainEqual({
      type: "plan.updated",
      items: [
        { text: "First", status: "in_progress" },
        { text: "Second", status: "pending" }
      ]
    })
  })
})

layer(NodeProcessLayer, { excludeTestServices: true })("OpenCode adapter (fake OpenCode 2 server)", (it) => {
  const adapter = makeOpenCodeAdapter({ binary: join(__dirname, "fake-opencode.mjs"), startupTimeoutMs: 10_000 })
  const run = (
    prompt: string,
    onEvent: (e: AgentEvent, s: HarnessSession) => Effect.Effect<void, unknown>,
    turns: number,
    policy: Parameters<typeof adapter.start>[0]["policy"] = { permissionMode: "ask" }
  ) =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy, prompt })
      const seen: Array<AgentEvent> = []
      let done = 0
      yield* session.events.pipe(
        Stream.tap((e) => {
          seen.push(e)
          if (e.type === "turn.completed") done++
          return onEvent(e, session)
        }),
        Stream.takeUntil(() => done >= turns),
        Stream.runDrain,
        Effect.timeout("20 seconds")
      )
      return seen
    })
  const texts = (seen: ReadonlyArray<AgentEvent>) => seen.flatMap((e) => (e.type === "message.completed" ? [e.text] : []))

  it.effect("streams turns past unknown events, round-trips permissions and accepts follow-ups", () =>
    Effect.gen(function* () {
      let followUps = 0
      const seen = yield* run(
        "use tool",
        (e, s) =>
          Effect.gen(function* () {
            if (e.type === "approval.requested") yield* s.respondToApproval(e.providerRequestId!, { decision: "allow", scope: "session" })
            if (e.type === "turn.completed" && e.status === "success" && followUps++ === 0) yield* s.prompt("again")
          }),
        2
      )
      expect(seen[0]).toMatchObject({ type: "session.started", providerSessionId: "ses_fake" })
      expect(seen.find((e) => e.type === "approval.requested")).toMatchObject({ toolName: "shell", canAllowForSession: true })
      // "Allow for session" saves OpenCode's proposed pattern.
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ result: "file always", isError: false })
      expect(texts(seen)).toEqual(["echo use tool", "echo again"])
      expect(seen.filter((e) => e.type === "turn.completed")).toHaveLength(2)
    })
  )

  it.effect("a denial with a note rejects the request", () =>
    Effect.gen(function* () {
      const seen = yield* run(
        "use tool",
        (e, s) =>
          e.type === "approval.requested" ? s.respondToApproval(e.providerRequestId!, { decision: "deny", note: "not now" }) : Effect.void,
        1
      )
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ isError: true, result: "rejected by user" })
    })
  )

  it.effect("answers a subagent's permission request on the subagent's session", () =>
    Effect.gen(function* () {
      const seen = yield* run(
        "subagent",
        (e, s) => (e.type === "approval.requested" ? s.respondToApproval(e.providerRequestId!, { decision: "allow" }) : Effect.void),
        1
      )
      expect(texts(seen)).toEqual(["echo subagent", "child permission ses_child:once"])
    })
  )

  it.effect("answers forms with field values", () =>
    Effect.gen(function* () {
      const seen = yield* run(
        "form",
        (e, s) =>
          e.type === "approval.requested"
            ? s.respondToApproval(e.providerRequestId!, { decision: "allow", answers: { indent: ["Spaces"], tests: ["Yes"] } })
            : Effect.void,
        1
      )
      expect(seen.find((e) => e.type === "approval.requested")).toMatchObject({
        kind: "question",
        questions: [{ id: "indent" }, { id: "tests" }]
      })
      expect(texts(seen).at(-1)).toBe('answered {"indent":"space","tests":true}')
    })
  )

  it.effect("creates the session with the model and effort, and switches them per prompt", () =>
    Effect.gen(function* () {
      const seen = yield* run("model?", () => Effect.void, 1, { permissionMode: "ask", model: "opencode/fake-free", effort: "high" })
      const echoed = (text: string | undefined) => {
        const m = /^model (.*) files (\d+)$/.exec(text ?? "")
        return m ? { model: JSON.parse(m[1]!), files: Number(m[2]) } : undefined
      }
      expect(echoed(texts(seen).at(-1))).toEqual({ model: { providerID: "opencode", id: "fake-free", variant: "high" }, files: 0 })
      const switched = yield* Effect.gen(function* () {
        const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" } })
        yield* session.prompt("model?", [{ mimeType: "image/png", data: "", path: "/tmp/shot.png" }], {
          model: "acme/big/model-1",
          effort: "max"
        })
        const out: Array<AgentEvent> = []
        yield* session.events.pipe(
          Stream.tap((e) => Effect.sync(() => out.push(e))),
          Stream.takeUntil((e) => e.type === "turn.completed"),
          Stream.runDrain,
          Effect.timeout("20 seconds")
        )
        return texts(out).at(-1)
      })
      expect(echoed(switched)).toEqual({ model: { providerID: "acme", id: "big/model-1", variant: "max" }, files: 1 })
    })
  )

  it.effect("interrupts", () =>
    Effect.gen(function* () {
      const seen = yield* run("hang", (e, s) => (e.type === "message.completed" ? s.interrupt : Effect.void), 1)
      expect(seen.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" })
    })
  )

  it.effect("detects the CLI and falls back to the plain model list", () =>
    Effect.gen(function* () {
      const d = yield* adapter.detect
      expect(d).toMatchObject({ installed: true, version: "2.2.6" })
      expect(d.models?.map((m) => m.id)).toEqual(["opencode/fake-free", "acme/big/model-1"])
    })
  )
})
