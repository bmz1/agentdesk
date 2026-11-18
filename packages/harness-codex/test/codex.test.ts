import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { type HarnessSession, NodeProcessLayer, parseJsonLine } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { describe, expect, it, layer } from "@effect/vitest"
import { CodexNormalizer, codexPolicy, makeCodexAdapter } from "../src"

describe("codexPolicy", () => {
  it("routes auto-mode escalations to Codex's auto reviewer inside the workspace sandbox", () => {
    expect(codexPolicy("auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" })
    expect(codexPolicy("accept_edits")).not.toHaveProperty("approvalsReviewer")
  })
})

describe("CodexNormalizer", () => {
  it("normalizes a golden app-server transcript", () => {
    const n = new CodexNormalizer()
    const events = readFileSync(join(__dirname, "fixtures/turn.jsonl"), "utf8")
      .split("\n")
      .flatMap((l) => {
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
      "tool.started",
      "approval.requested",
      "tool.completed",
      "reasoning",
      "session.error",
      "turn.completed"
    ])
    expect(events[5]).toMatchObject({ providerRequestId: "0", toolName: "Bash", summary: "Bash: pnpm test" })
    expect(events[6]).toMatchObject({ isError: true, result: "1 failed" })
    expect(events[8]).toMatchObject({ providerRequestId: "5", summary: "Edit: src/a.ts" })
    expect(events.at(-1)).toMatchObject({ status: "success", providerSessionId: "thr_1", durationMs: 4200 })
    expect(n.activeTurnId).toBeUndefined()
  })
})

layer(NodeProcessLayer, { excludeTestServices: true })("Codex adapter (fake app-server)", (it) => {
  const adapter = makeCodexAdapter({ binary: join(__dirname, "fake-codex.mjs"), requestTimeoutMs: 5000 })

  const collect = (prompt: string, onEvent: (e: AgentEvent, s: HarnessSession) => Effect.Effect<void, unknown>, turns: number) =>
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
      return { seen, threadId: yield* session.providerSessionId }
    })

  it.effect("round-trips approvals and queues follow-ups through the scoped turn loop", () =>
    Effect.gen(function* () {
      let sentFollowUp = false
      const { seen, threadId } = yield* collect(
        "run cmd",
        (e, s) =>
          Effect.gen(function* () {
            if (e.type === "approval.requested") yield* s.respondToApproval(e.providerRequestId!, { decision: "allow" })
            if (e.type === "tool.started" && !sentFollowUp) {
              sentFollowUp = true
              yield* s.prompt("follow up") // queued until the first turn completes
            }
          }),
        2
      )
      expect(threadId).toBe("thr_fake")
      expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ isError: false, result: "file" })
      expect(seen.filter((e) => e.type === "message.completed").map((e) => (e as { text: string }).text)).toEqual([
        "echo run cmd",
        "echo follow up"
      ])
    })
  )

  it.effect("sends model and extra instructions when resuming a provider conversation", () =>
    Effect.gen(function* () {
      const log = join(mkdtempSync(join(tmpdir(), "codex-defaults-")), "rpc.jsonl")
      const session = yield* adapter.resume!({
        cwd: tmpdir(), providerSessionId: "thr_existing", prompt: "continue",
        policy: { permissionMode: "plan", model: "chosen-model", appendSystemPrompt: "Follow the defaults.", env: { AGENTDESK_TEST_CODEX_LOG: log } }
      })
      yield* session.events.pipe(Stream.takeUntil((e) => e.type === "turn.completed"), Stream.runDrain)
      const request = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((m) => m.method === "thread/resume")
      expect(request.params).toMatchObject({ threadId: "thr_existing", model: "chosen-model", developerInstructions: "Follow the defaults." })
    })
  )

  it.effect("answers questions, reports the plan, usage and account limits", () =>
    Effect.gen(function* () {
      const { seen } = yield* collect(
        "plan then ask",
        (e, s) => (e.type === "approval.requested" ? s.respondToApproval(e.providerRequestId!, { decision: "allow", answers: { db: ["Postgres"] } }) : Effect.void),
        1
      )
      expect(seen.find((e) => e.type === "approval.requested")).toMatchObject({
        kind: "question",
        summary: "Which database?",
        questions: [{ id: "db", header: "Database", question: "Which database?", allowOther: true, options: [{ label: "SQLite", description: "Embedded" }] }]
      })
      expect(seen.find((e) => e.type === "message.completed" && e.text.startsWith("answer"))).toMatchObject({ text: "answer: Postgres" })
      expect(seen.find((e) => e.type === "plan.updated")).toEqual({ type: "plan.updated", items: [{ text: "Read", status: "completed" }, { text: "Write", status: "in_progress" }] })
      expect(seen.find((e) => e.type === "rate_limit")).toMatchObject({
        windows: [
          { id: "primary", label: "5-hour", usedPercent: 40, resetsAt: new Date(1800000000 * 1000).toISOString() },
          { id: "secondary", label: "Weekly", usedPercent: 10 }
        ],
        limited: false
      })
      expect(seen.find((e) => e.type === "turn.completed")).toMatchObject({ usage: { inputTokens: 500, cacheReadTokens: 1000, outputTokens: 70 } })
    })
  )

  it.effect("approves edits itself in accept-edits mode, and asks in ask mode", () =>
    Effect.gen(function* () {
      const run = (permissionMode: "ask" | "accept_edits") =>
        Effect.gen(function* () {
          const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode }, prompt: "edit a file" })
          const seen: Array<AgentEvent> = []
          yield* session.events.pipe(
            Stream.tap((e) => {
              seen.push(e)
              return e.type === "approval.requested" ? session.respondToApproval(e.providerRequestId!, { decision: "allow", scope: "session" }) : Effect.void
            }),
            Stream.takeUntil((e) => e.type === "turn.completed"),
            Stream.runDrain
          )
          return seen
        })
      const auto = yield* run("accept_edits")
      expect(auto.some((e) => e.type === "approval.requested")).toBe(false)
      expect(auto.find((e) => e.type === "message.completed" && e.text.startsWith("edit"))).toMatchObject({ text: "edit: accept" })
      const asked = yield* run("ask")
      expect(asked.find((e) => e.type === "approval.requested")).toMatchObject({ toolName: "Edit", canAllowForSession: true })
      expect(asked.find((e) => e.type === "message.completed" && e.text.startsWith("edit"))).toMatchObject({ text: "edit: acceptForSession" })
      expect(codexPolicy("ask")).toEqual({ approvalPolicy: "untrusted", sandbox: "workspace-write" })
    })
  )

  it.effect("interrupts a turn whose id has not arrived yet", () =>
    Effect.gen(function* () {
      const session = yield* adapter.start({ cwd: tmpdir(), policy: { permissionMode: "ask" } })
      yield* session.prompt("slowstart hang")
      yield* Effect.sleep("50 millis")
      yield* session.interrupt
      const turn = yield* session.events.pipe(Stream.filter((e) => e.type === "turn.completed"), Stream.runHead)
      expect(turn._tag === "Some" && turn.value).toMatchObject({ status: "interrupted" })
    })
  )

  it.effect("interrupts the active turn", () =>
    Effect.gen(function* () {
      const { seen } = yield* collect("hang", (e, s) => (e.type === "message.completed" ? s.interrupt : Effect.void), 1)
      expect(seen.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" })
    })
  )
})
