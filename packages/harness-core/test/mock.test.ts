import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, layer } from "@effect/vitest"
import type { AgentEvent } from "@agentdesk/contracts"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { makeMockAdapter, NodeProcessLayer } from "../src"

// The adapter contract requires a process spawner even though the mock never spawns one.
layer(NodeProcessLayer)("mock harness", (it) => {
  it.effect("streams a turn, requests approval and writes a file once allowed", () =>
    Effect.gen(function* () {
      const cwd = mkdtempSync(join(tmpdir(), "mock-"))
      const session = yield* makeMockAdapter({ delayMs: 0 }).start({ cwd, policy: { permissionMode: "ask" }, prompt: "hello" })
      const events: Array<AgentEvent> = []
      yield* session.events.pipe(
        Stream.tap((e) =>
          Effect.gen(function* () {
            events.push(e)
            if (e.type === "approval.requested") yield* session.respondToApproval(e.providerRequestId!, { decision: "allow" })
          })
        ),
        Stream.takeUntil((e) => e.type === "turn.completed"),
        Stream.runDrain
      )
      const types = events.map((e) => e.type)
      expect(types[0]).toBe("session.started")
      expect(types).toContain("approval.requested")
      expect(types.at(-1)).toBe("turn.completed")
      expect(readFileSync(join(cwd, "AGENTDESK_NOTES.md"), "utf8")).toContain("hello")
    })
  )

  it.effect("interrupt cancels the in-flight turn fiber (driven by TestClock)", () =>
    Effect.gen(function* () {
      const session = yield* makeMockAdapter({ delayMs: 1000 }).start({
        cwd: tmpdir(),
        policy: { permissionMode: "accept_edits" },
        prompt: "a long answer"
      })
      const collector = yield* session.events.pipe(
        Stream.takeUntil((e) => e.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* TestClock.adjust("2500 millis") // three words streamed
      yield* session.interrupt
      const events = yield* Fiber.join(collector)
      expect(events.filter((e) => e.type === "message.delta")).toHaveLength(3)
      expect(events.at(-1)).toEqual({ type: "turn.completed", providerSessionId: expect.any(String), status: "interrupted" })
    })
  )
})
