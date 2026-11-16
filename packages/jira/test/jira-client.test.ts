import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { adfToText, incrementalJql, makeJiraClient } from "../src"
import { makeFakeJira } from "./fake-jira"

const issues = Array.from({ length: 7 }, (_, i) => ({ id: String(1000 + i), key: `SEON-${i + 1}`, summary: `Issue ${i + 1}` }))

describe("Jira client", () => {
  it("paginates Jira Cloud enhanced search with nextPageToken", async () => {
    const fake = makeFakeJira({ deployment: "cloud", issues })
    const client = makeJiraClient({ deployment: "cloud", baseUrl: "https://x.atlassian.net/", principal: "me@x", token: "t", fetch: fake.fetch, pageSize: 3 })
    const all = await Effect.runPromise(client.searchAll("project = SEON"))
    expect(all.map((i) => i.key)).toEqual(issues.map((i) => i.key))
    expect(fake.state.calls.map((c) => c.path)).toEqual(Array(3).fill("/rest/api/3/search/jql"))
    expect(fake.state.calls[1]!.body.nextPageToken).toBe("3")
    expect(all[0]!.url).toBe("https://x.atlassian.net/browse/SEON-1")
  })

  it("paginates Data Center search with startAt", async () => {
    const fake = makeFakeJira({ deployment: "datacenter", issues })
    const client = makeJiraClient({ deployment: "datacenter", baseUrl: "https://jira.corp", principal: "", token: "pat", fetch: fake.fetch, pageSize: 4 })
    const all = await Effect.runPromise(client.searchAll("project = SEON"))
    expect(all).toHaveLength(7)
    expect(fake.state.calls.map((c) => c.body.startAt)).toEqual([0, 4])
  })

  it("backs off and retries on 429 and 5xx", async () => {
    const fake = makeFakeJira({ deployment: "cloud", issues: issues.slice(0, 2) })
    fake.state.rateLimitNext = 2
    fake.state.serverErrorsNext = 1
    const client = makeJiraClient({ deployment: "cloud", baseUrl: "https://x", principal: "a", token: "b", fetch: fake.fetch, retryBaseMs: 1 })
    const all = await Effect.runPromise(client.searchAll("x"))
    expect(all).toHaveLength(2)
    expect(fake.state.calls).toHaveLength(4)
  })

  it("does not retry auth failures", async () => {
    const fake = makeFakeJira({ deployment: "cloud", issues })
    fake.state.failAuth = true
    const client = makeJiraClient({ deployment: "cloud", baseUrl: "https://x", principal: "a", token: "b", fetch: fake.fetch, retryBaseMs: 1 })
    const exit = await Effect.runPromiseExit(client.searchAll("x"))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('"kind":"auth"')
    expect(fake.state.calls).toHaveLength(1)
  })

  it("builds incremental JQL that preserves ORDER BY", () => {
    const since = new Date(Date.UTC(2026, 10, 5, 9, 7))
    expect(incrementalJql("project = SEON ORDER BY rank", since)).toBe('(project = SEON) AND updated >= "2026/11/05 09:07" ORDER BY rank')
    expect(incrementalJql("assignee = currentUser()", since)).toBe(
      '(assignee = currentUser()) AND updated >= "2026/11/05 09:07" ORDER BY updated ASC'
    )
  })
})

describe("ADF to text", () => {
  it("renders paragraphs, lists, code and marks as plain text", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Goal" }] },
        { type: "paragraph", content: [{ type: "text", text: "Use " }, { type: "text", text: "redis", marks: [{ type: "code" }] }] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }
          ]
        },
        { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1" }] },
        { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script>" }] }
      ]
    }
    const text = adfToText(doc)
    expect(text).toContain("## Goal")
    expect(text).toContain("Use `redis`")
    expect(text).toContain("- one\n- two")
    expect(text).toContain("```ts\nconst x = 1\n```")
    // Untrusted markup survives as inert text; rendering escapes it.
    expect(text).toContain("<script>alert(1)</script>")
    expect(adfToText("plain DC wiki text")).toBe("plain DC wiki text")
    expect(adfToText(null)).toBe("")
  })
})
