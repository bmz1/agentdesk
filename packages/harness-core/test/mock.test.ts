import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@agentdesk/contracts"
import { Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { makeMockAdapter } from "../src"

describe("mock harness", () => {
  it("streams a turn, requests approval and writes a file once allowed", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mock-"))
    const adapter = makeMockAdapter({ delayMs: 0 })
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* adapter.start({ cwd, policy: { permissionMode: "ask" }, prompt: "hello" })
          const collected: Array<AgentEvent> = []
          const fiber = yield* session.events.pipe(
            Stream.tap((e) =>
              Effect.gen(function* () {
                collected.push(e)
                if (e.type === "approval.requested") yield* session.respondToApproval(e.providerRequestId!, "allow")
              })
            ),
            Stream.takeUntil((e) => e.type === "turn.completed"),
            Stream.runDrain,
            Effect.forkChild
          )
          yield* Fiber.join(fiber)
          return collected
        })
      )
    )
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("session.started")
    expect(types).toContain("approval.requested")
    expect(types.at(-1)).toBe("turn.completed")
    expect(readFileSync(join(cwd, "AGENTDESK_NOTES.md"), "utf8")).toContain("hello")
  })
})
