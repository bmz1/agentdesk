/** In-memory Linear GraphQL API for tests. */
export interface FakeLinearIssue {
  id: string
  identifier: string
  title: string
  team?: string
  stateType?: string
  stateName?: string
  assignee?: string | null
  isMine?: boolean
  labels?: Array<string>
  updatedAt?: string
  description?: string | null
}

export const makeFakeLinear = (opts: { issues: Array<FakeLinearIssue>; pageSize?: number }) => {
  const state = {
    issues: opts.issues,
    calls: [] as Array<{ query: string; variables: any; auth: string | null }>,
    rateLimitNext: 0,
    failAuth: false
  }
  const matches = (i: FakeLinearIssue, f: any) => {
    if (f?.team?.key?.eq && (i.team ?? "ENG") !== f.team.key.eq) return false
    if (f?.assignee?.isMe?.eq && !i.isMine) return false
    if (f?.state?.type?.nin && f.state.type.nin.includes(i.stateType ?? "started")) return false
    if (f?.labels?.name?.eq && !(i.labels ?? []).includes(f.labels.name.eq)) return false
    if (f?.updatedAt?.gte && (i.updatedAt ?? "2026-11-01T00:00:00.000Z") < f.updatedAt.gte) return false
    return true
  }
  const fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    const auth = new Headers(init?.headers).get("authorization")
    state.calls.push({ query: body.query, variables: body.variables, auth })
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
    if (state.failAuth) return json(400, { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] })
    if (state.rateLimitNext > 0) {
      state.rateLimitNext--
      return json(400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] })
    }
    if (body.query.includes("viewer")) return json(200, { data: { viewer: { name: "Ada" } } })
    const visible = state.issues.filter((i) => matches(i, body.variables.filter))
    const start = Number(body.variables.after ?? 0)
    const size = opts.pageSize ?? body.variables.first
    const page = visible.slice(start, start + size)
    return json(200, {
      data: {
        issues: {
          nodes: page.map((i) => ({
            id: i.id,
            identifier: i.identifier,
            url: `https://linear.app/acme/issue/${i.identifier}`,
            title: i.title,
            description: i.description ?? null,
            updatedAt: i.updatedAt ?? "2026-11-01T00:00:00.000Z",
            priority: 2,
            state: { name: i.stateName ?? "In Progress", type: i.stateType ?? "started" },
            assignee: i.assignee ? { displayName: i.assignee } : null,
            labels: { nodes: (i.labels ?? []).map((name) => ({ name })) }
          })),
          pageInfo: { hasNextPage: start + size < visible.length, endCursor: String(start + size) }
        }
      }
    })
  }) as typeof globalThis.fetch
  return { fetch, state }
}
