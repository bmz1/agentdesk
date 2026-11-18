import { describe, expect, it } from "@effect/vitest"
import { agentSessions } from "@agentdesk/db"
import { Effect } from "effect"
import { EventLog } from "../src/services/event-log"
import { Database } from "../src/services/database"
import { Projects } from "../src/services/projects"
import { Tickets } from "../src/services/tickets"
import { makeRepo, TestApp } from "./support"

describe("dashboard message previews", () => {
  it.effect("returns only the latest meaningful, bounded message for the requested session", () =>
    Effect.gen(function* () {
      const p = yield* Projects.use((x) => x.create({ name: "Preview", repoPath: makeRepo() }))
      const t = yield* Tickets.use((x) => x.create({ projectId: p.id, title: "t" }))
      const { use } = yield* Database
      yield* use((db) =>
        db
          .insert(agentSessions)
          .values(
            ["s1", "s2"].map((id) => ({
              id,
              ticketId: t.id,
              harness: "mock",
              state: "closed",
              cwd: "/",
              createdAt: "2026-11-17",
              updatedAt: "2026-11-17"
            }))
          )
          .run()
      )
      const log = yield* EventLog
      expect(yield* log.preview("s1")).toBeNull()
      yield* log.append("s1", { type: "user.prompt", text: "Start here" })
      yield* log.append("s2", { type: "message.completed", text: "Other session" })
      expect(yield* log.preview("s1")).toBe("Start here")
      yield* log.append("s1", { type: "approval.requested", approvalId: "a", toolName: "Bash", summary: "May I run tests?" })
      yield* log.append("s1", { type: "message.delta", text: "Partial" })
      expect(yield* log.preview("s1")).toBe("May I run tests?")
      yield* log.append("s1", { type: "message.completed", text: "x".repeat(800) })
      yield* log.append("s1", { type: "turn.completed", status: "success" })
      expect(yield* log.preview("s1")).toBe("x".repeat(500))
    }).pipe(Effect.provide(TestApp()))
  )
})
