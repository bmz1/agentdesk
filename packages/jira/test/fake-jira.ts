/** In-memory Jira Cloud/DC search API for tests. */
export interface FakeIssue {
  id: string
  key: string
  summary: string
  status?: string
  category?: "new" | "indeterminate" | "done"
  updated?: string
  description?: unknown
  labels?: Array<string>
  assignee?: string | null
}

export const makeFakeJira = (opts: { deployment: "cloud" | "datacenter"; issues: Array<FakeIssue>; pageSize?: number }) => {
  const state = {
    issues: opts.issues,
    calls: [] as Array<{ path: string; body: any }>,
    rateLimitNext: 0,
    failAuth: false,
    serverErrorsNext: 0,
    /** Optional JQL filter: return true to include */
    filter: undefined as undefined | ((issue: FakeIssue, jql: string) => boolean)
  }
  const toPayload = (i: FakeIssue) => ({
    id: i.id,
    key: i.key,
    fields: {
      summary: i.summary,
      description: i.description ?? null,
      status: { name: i.status ?? "To Do", statusCategory: { key: i.category ?? "new" } },
      assignee: i.assignee === undefined ? null : i.assignee === null ? null : { displayName: i.assignee },
      labels: i.labels ?? [],
      priority: { name: "Medium" },
      updated: i.updated ?? "2026-11-01T10:00:00.000+0000",
      issuetype: { name: "Task" }
    }
  })
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    state.calls.push({ path, body })
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } })
    if (state.failAuth) return json(401, { errorMessages: ["nope"] })
    if (state.rateLimitNext > 0) {
      state.rateLimitNext--
      return json(429, {}, { "retry-after": "0" })
    }
    if (state.serverErrorsNext > 0) {
      state.serverErrorsNext--
      return json(503, {})
    }
    if (path.endsWith("/myself")) return json(200, { displayName: "Test User" })
    const visible = state.issues.filter((i) => !state.filter || state.filter(i, body.jql))
    const size = body.maxResults ?? opts.pageSize ?? 50
    if (opts.deployment === "cloud" && path === "/rest/api/3/search/jql") {
      const start = Number(body.nextPageToken ?? 0)
      const page = visible.slice(start, start + size)
      const next = start + size
      return json(200, {
        issues: page.map(toPayload),
        ...(next < visible.length ? { nextPageToken: String(next) } : {}),
        isLast: next >= visible.length
      })
    }
    if (opts.deployment === "datacenter" && path === "/rest/api/2/search") {
      const start = body.startAt ?? 0
      return json(200, {
        issues: visible.slice(start, start + size).map(toPayload),
        startAt: start,
        maxResults: size,
        total: visible.length
      })
    }
    return json(404, {})
  }) as typeof globalThis.fetch
  return { fetch, state }
}
