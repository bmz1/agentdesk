import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { parseJsonLine } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { makeOpenCodeAdapter, OpenCodeNormalizer, openCodePermissions } from "../src"

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

describe("OpenCode adapter (fake server)", () => {
  const adapter = makeOpenCodeAdapter({ binary: join(__dirname, "fake-opencode.mjs"), startupTimeoutMs: 10_000 })
  const run = (prompt: string, onEvent: (e: AgentEvent, s: any) => Effect.Effect<void, any>, turns: number) =>
    Effect.runPromise(
      Effect.scoped(
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
      )
    )

  it("streams, round-trips permissions and accepts follow-ups", async () => {
    const seen = await run(
      "use tool",
      (e, s) =>
        Effect.gen(function* () {
          if (e.type === "approval.requested") yield* s.respondToApproval(e.providerRequestId!, "allow")
          if (e.type === "turn.completed" && e.status === "success") yield* s.prompt("again")
        }),
      2
    )
    expect(seen[0]).toMatchObject({ type: "session.started", providerSessionId: "ses_fake" })
    expect(seen.find((e) => e.type === "tool.completed")).toMatchObject({ result: "file", isError: false })
    expect(seen.filter((e) => e.type === "message.completed").map((e: any) => e.text)).toEqual(["echo use tool", "echo again"])
  })

  it("interrupts via abort", async () => {
    const seen = await run("hang", (e, s) => (e.type === "message.completed" ? s.interrupt : Effect.void), 1)
    expect(seen.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" })
  })
})

describe("OpenCodeNormalizer errors", () => {
  it("reports a failed turn when the session errored before going idle", () => {
    const n = new OpenCodeNormalizer("s")
    n.markBusy()
    n.push({ type: "session.error", properties: { sessionID: "s", error: { name: "ProviderAuthError", data: { message: "no key" } } } })
    expect(n.push({ type: "session.idle", properties: { sessionID: "s" } })).toEqual([
      { type: "turn.completed", providerSessionId: "s", status: "error" }
    ])
  })
})
