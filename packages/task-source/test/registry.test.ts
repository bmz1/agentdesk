import { jiraSource } from "@agentdesk/jira"
import { linearSource } from "@agentdesk/linear"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeSourceRegistry } from "../src"

describe("source registry", () => {
  const registry = makeSourceRegistry([jiraSource, linearSource])

  it("describes every adapter for UIs", () => {
    expect(registry.descriptors.map((d) => d.id)).toEqual(["jira", "linear"])
    expect(registry.descriptors[1]!.fields.map((f) => f.key)).toEqual(["teamKey", "assignee", "states", "label"])
  })

  it.effect("decodes settings per source and fails with typed errors", () =>
    Effect.gen(function* () {
      expect(yield* registry.decodeSettings("linear", { teamKey: "ENG", assignee: "mine", states: "open" })).toMatchObject({ teamKey: "ENG" })
      expect((yield* Effect.flip(registry.decodeSettings("linear", { teamKey: "ENG" })))._tag).toBe("SchemaError")
      expect(yield* Effect.flip(registry.get("trello"))).toMatchObject({ _tag: "TaskSourceError", kind: "config" })
    })
  )

  it("reserves the id of local tickets", () => {
    expect(() => makeSourceRegistry([{ ...linearSource, id: "local" }])).toThrow(/reserved/)
  })
})
