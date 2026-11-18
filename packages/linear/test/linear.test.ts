import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { buildFilter, categoryOf, linearSource } from "../src"
import { makeFakeLinear } from "./fake-linear"

const issues = [
  { id: "u1", identifier: "ENG-1", title: "Mine, started", isMine: true },
  { id: "u2", identifier: "ENG-2", title: "Mine, done", isMine: true, stateType: "completed", stateName: "Done" },
  { id: "u3", identifier: "ENG-3", title: "Someone else", assignee: "Bob" },
  { id: "u4", identifier: "OPS-1", title: "Other team", team: "OPS", isMine: true },
  {
    id: "u5",
    identifier: "ENG-5",
    title: "Mine, backlog",
    isMine: true,
    stateType: "backlog",
    stateName: "Backlog",
    labels: ["agent"],
    updatedAt: "2026-11-10T00:00:00.000Z"
  }
]
const settings = Schema.decodeUnknownSync(linearSource.settings)({ teamKey: "ENG", assignee: "mine", states: "open" })
const key = Redacted.make("lin_api_secret")

const drain = (client: ReturnType<typeof linearSource.connect>, since?: Date) =>
  Effect.gen(function* () {
    const all = []
    let cursor: string | undefined
    do {
      const page = yield* client.fetchPage({ since, cursor })
      all.push(...page.tasks)
      cursor = page.cursor
    } while (cursor)
    return all
  })

describe("Linear task source", () => {
  it.effect("pages through a team's issues with the configured filters and normalizes them", () =>
    Effect.gen(function* () {
      const fake = makeFakeLinear({ issues, pageSize: 1 })
      const tasks = yield* drain(linearSource.connect(settings, key, { fetch: fake.fetch }))
      expect(tasks.map((t) => t.key)).toEqual(["ENG-1", "ENG-5"])
      expect(tasks[1]).toMatchObject({
        remoteId: "u5",
        url: "https://linear.app/acme/issue/ENG-5",
        status: "Backlog",
        statusCategory: "todo",
        labels: ["agent"]
      })
      // Personal API keys go in Authorization without "Bearer".
      expect(fake.state.calls[0]!.auth).toBe("lin_api_secret")
      expect(fake.state.calls.map((c) => c.variables.after)).toEqual([null, "1"])
    })
  )

  it.effect("incremental fetches filter by updatedAt", () =>
    Effect.gen(function* () {
      const fake = makeFakeLinear({ issues })
      const since = new Date("2026-11-05T00:00:00.000Z")
      const tasks = yield* drain(linearSource.connect(settings, key, { fetch: fake.fetch }), since)
      expect(tasks.map((t) => t.key)).toEqual(["ENG-5"])
      expect(fake.state.calls[0]!.variables.filter.updatedAt).toEqual({ gte: since.toISOString() })
    })
  )

  it.effect("retries rate limits with exponential backoff (virtual time) and fails fast on auth", () =>
    Effect.gen(function* () {
      const fake = makeFakeLinear({ issues })
      fake.state.rateLimitNext = 2
      const fiber = yield* Effect.forkChild(linearSource.connect(settings, key, { fetch: fake.fetch }).fetchPage({}))
      for (const ms of [0, 1000, 2000]) {
        yield* TestClock.adjust(`${ms} millis`)
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 5)))
      }
      expect((yield* Fiber.join(fiber)).tasks).toHaveLength(2)
      expect(fake.state.calls).toHaveLength(3)

      fake.state.failAuth = true
      const error = yield* Effect.flip(linearSource.connect(settings, key, { fetch: fake.fetch }).test)
      expect(error).toMatchObject({ _tag: "TaskSourceError", source: "linear", kind: "auth" })
      const missingKey = yield* Effect.flip(linearSource.connect(settings, undefined).test)
      expect(missingKey.kind).toBe("config")
    })
  )

  it("maps workflow state types and builds filters", () => {
    expect(["triage", "backlog", "unstarted", "started", "completed", "canceled", "weird"].map(categoryOf)).toEqual([
      "todo",
      "todo",
      "todo",
      "in_progress",
      "done",
      "done",
      null
    ])
    expect(buildFilter({ teamKey: "ENG", assignee: "anyone", states: "all", label: "x" })).toEqual({
      team: { key: { eq: "ENG" } },
      labels: { name: { eq: "x" } }
    })
    expect(() => Schema.decodeUnknownSync(linearSource.settings)({ teamKey: "", assignee: "mine", states: "open" })).toThrow()
  })
})
