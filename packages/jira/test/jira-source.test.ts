import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted, Schema } from "effect"
import { jiraSource } from "../src"
import { makeFakeJira } from "./fake-jira"

const decode = Schema.decodeUnknownSync(jiraSource.settings)

describe("Jira task source", () => {
  it("validates settings with its schema", () => {
    expect(() => decode({ deployment: "cloud", baseUrl: "http://evil.example", principal: "a@b", jql: "x" })).toThrow(/https/)
    expect(() => decode({ deployment: "cloud", baseUrl: "https://x.atlassian.net", principal: "", jql: "x" })).toThrow(/email/)
    expect(() => decode({ deployment: "datacenter", baseUrl: "https://jira.corp", principal: "", jql: "" })).toThrow()
    expect(decode({ deployment: "datacenter", baseUrl: "https://jira.corp", principal: "", jql: "project = X" }).jql).toBe("project = X")
  })

  it.effect("maps issues to RemoteTasks and narrows incremental fetches", () =>
    Effect.gen(function* () {
      const fake = makeFakeJira({
        deployment: "cloud",
        issues: [{ id: "1", key: "SEON-1", summary: "A", category: "indeterminate", status: "In Progress", labels: ["x"] }]
      })
      const client = jiraSource.connect(
        decode({ deployment: "cloud", baseUrl: "https://seon.atlassian.net/", principal: "me@seon.io", jql: "project = SEON" }),
        Redacted.make("t"),
        { fetch: fake.fetch }
      )
      const page = yield* client.fetchPage({})
      expect(page.tasks[0]).toMatchObject({
        remoteId: "1",
        key: "SEON-1",
        url: "https://seon.atlassian.net/browse/SEON-1",
        statusCategory: "in_progress",
        labels: ["x"]
      })
      yield* client.fetchPage({ since: new Date(Date.UTC(2026, 10, 5, 9, 0)) })
      expect(fake.state.calls.at(-1)!.body.jql).toBe('(project = SEON) AND updated >= "2026/11/05 09:00" ORDER BY updated ASC')
      fake.state.failAuth = true
      expect(yield* Effect.flip(client.test)).toMatchObject({ _tag: "TaskSourceError", source: "jira", kind: "auth" })
    })
  )
})
