import { type FetchPageRequest, type RemoteTask, type TaskPage, type TaskSourceAdapter, TaskSourceError } from "@agentdesk/task-source"
import { Duration, Effect, Redacted, Schedule, Schema } from "effect"

export const LINEAR_API = "https://api.linear.app/graphql"

export const LinearSettings = Schema.Struct({
  /** Team key, e.g. "ENG". */
  teamKey: Schema.NonEmptyString,
  /** "mine" limits to issues assigned to the API key's user. */
  assignee: Schema.Literals(["mine", "anyone"]),
  /** "open" excludes completed and canceled issues. */
  states: Schema.Literals(["open", "all"]),
  /** Optional label name filter. */
  label: Schema.optional(Schema.String)
})
export type LinearSettings = typeof LinearSettings.Type

const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  url: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  priority: Schema.optional(Schema.NullOr(Schema.Number)),
  state: Schema.NullOr(Schema.Struct({ name: Schema.String, type: Schema.String })),
  assignee: Schema.NullOr(Schema.Struct({ displayName: Schema.String })),
  labels: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ name: Schema.String })) })
})
type Issue = typeof Issue.Type

const IssuesResponse = Schema.Struct({
  data: Schema.Struct({
    issues: Schema.Struct({
      nodes: Schema.Array(Issue),
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) })
    })
  })
})
const ViewerResponse = Schema.Struct({ data: Schema.Struct({ viewer: Schema.Struct({ name: Schema.String }) }) })

export const ISSUES_QUERY = /* GraphQL */ `
  query AgentDeskIssues($filter: IssueFilter, $after: String, $first: Int!) {
    issues(filter: $filter, after: $after, first: $first, orderBy: updatedAt) {
      nodes {
        id
        identifier
        url
        title
        description
        updatedAt
        priority
        state {
          name
          type
        }
        assignee {
          displayName
        }
        labels {
          nodes {
            name
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

/** Linear workflow state types → AgentDesk's initial board column. */
export const categoryOf = (type: string | undefined): RemoteTask["statusCategory"] => {
  switch (type) {
    case "backlog":
    case "unstarted":
    case "triage":
      return "todo"
    case "started":
      return "in_progress"
    case "completed":
    case "canceled":
      return "done"
    default:
      return null
  }
}

export const buildFilter = (settings: LinearSettings, since?: Date) => ({
  team: { key: { eq: settings.teamKey } },
  ...(settings.assignee === "mine" && { assignee: { isMe: { eq: true } } }),
  ...(settings.states === "open" && { state: { type: { nin: ["completed", "canceled"] } } }),
  ...(settings.label && { labels: { name: { eq: settings.label } } }),
  ...(since && { updatedAt: { gte: since.toISOString() } })
})

const toTask = (i: Issue): RemoteTask => ({
  remoteId: i.id,
  key: i.identifier,
  url: i.url,
  title: i.title,
  description: i.description ?? "",
  status: i.state?.name ?? null,
  statusCategory: categoryOf(i.state?.type),
  assignee: i.assignee?.displayName ?? null,
  labels: i.labels.nodes.map((l) => l.name),
  updatedAt: i.updatedAt,
  raw: { priority: i.priority ?? null }
})

export interface LinearClientOptions {
  readonly apiKey: Redacted.Redacted<string>
  readonly fetch?: typeof globalThis.fetch
  readonly endpoint?: string
  readonly pageSize?: number
  readonly retryBaseMs?: number
  readonly maxRetries?: number
}

/** Minimal read-only Linear GraphQL client with typed errors and retry/backoff. */
export const makeLinearClient = (options: LinearClientOptions) => {
  const doFetch = options.fetch ?? globalThis.fetch
  const fail = (kind: TaskSourceError["kind"], message: string, status?: number) =>
    new TaskSourceError({ source: "linear", kind, message, status })

  const graphql = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    query: string,
    variables: Record<string, unknown>
  ): Effect.Effect<S["Type"], TaskSourceError> =>
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          doFetch(options.endpoint ?? LINEAR_API, {
            method: "POST",
            signal,
            // Personal API keys are sent as-is (no "Bearer" prefix).
            headers: { Authorization: Redacted.value(options.apiKey), "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables })
          }),
        catch: (e) => fail("network", `Linear unreachable: ${String(e)}`)
      })
      const json = (yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: () => fail("invalid_response", `Linear returned ${res.status} with invalid JSON`)
      })) as { errors?: Array<{ message?: string; extensions?: { code?: string } }> }
      const code = json.errors?.[0]?.extensions?.code
      if (res.status === 429 || code === "RATELIMITED") return yield* fail("rate_limited", "Linear rate limit hit", res.status)
      if (res.status === 401 || res.status === 403 || code === "AUTHENTICATION_ERROR" || code === "FORBIDDEN") {
        return yield* fail("auth", "Linear rejected the API key", res.status)
      }
      if (!res.ok || json.errors?.length) {
        return yield* fail("http", `Linear ${res.status}: ${json.errors?.map((e) => e.message).join("; ") ?? "request failed"}`, res.status)
      }
      return yield* (Schema.decodeUnknownEffect(schema)(json) as Effect.Effect<S["Type"], Schema.SchemaError>).pipe(
        Effect.mapError((e) => fail("invalid_response", `Unexpected Linear payload: ${e.message.slice(0, 300)}`))
      )
    }).pipe(
      Effect.retry({
        while: (e) => e.kind === "rate_limited" || e.kind === "network" || (e.kind === "http" && (e.status ?? 0) >= 500),
        times: options.maxRetries ?? 4,
        schedule: Schedule.exponential(Duration.millis(options.retryBaseMs ?? 1000), 2)
      })
    )

  return {
    viewer: graphql(ViewerResponse, "query { viewer { name } }", {}).pipe(Effect.map((r) => r.data.viewer.name)),
    issues: (settings: LinearSettings, request: FetchPageRequest): Effect.Effect<TaskPage, TaskSourceError> =>
      graphql(IssuesResponse, ISSUES_QUERY, {
        filter: buildFilter(settings, request.since),
        after: request.cursor ?? null,
        first: options.pageSize ?? 50
      }).pipe(
        Effect.map((r) => ({
          tasks: r.data.issues.nodes.map(toTask),
          cursor: r.data.issues.pageInfo.hasNextPage ? (r.data.issues.pageInfo.endCursor ?? undefined) : undefined
        })),
        Effect.withSpan("LinearClient.issues", { attributes: { team: settings.teamKey, incremental: !!request.since } })
      )
  }
}

/** Linear as a read-only task source, scoped by team (and optionally assignee/state/label). */
export const linearSource: TaskSourceAdapter<LinearSettings> = {
  id: "linear",
  displayName: "Linear",
  description: "Import issues from a Linear team (read-only).",
  settings: LinearSettings,
  fields: [
    { key: "teamKey", label: "Team key", type: "text", required: true, placeholder: "ENG" },
    {
      key: "assignee",
      label: "Issues",
      type: "select",
      required: true,
      default: "mine",
      options: [
        { value: "mine", label: "Assigned to me" },
        { value: "anyone", label: "Whole team" }
      ]
    },
    {
      key: "states",
      label: "States",
      type: "select",
      required: true,
      default: "open",
      options: [
        { value: "open", label: "Open only (exclude completed/canceled)" },
        { value: "all", label: "All" }
      ]
    },
    { key: "label", label: "Label (optional)", type: "text", placeholder: "agent-ready" }
  ],
  credential: { label: "Personal API key", hint: "Linear → Settings → API. Stored in the OS credential store.", required: true },
  connect: (settings, credential, options = {}) => {
    const client = Effect.suspend(() =>
      credential
        ? Effect.succeed(makeLinearClient({ apiKey: credential, fetch: options.fetch, retryBaseMs: options.retryBaseMs }))
        : Effect.fail(new TaskSourceError({ source: "linear", kind: "config", message: "No API key stored for this Linear connection" }))
    )
    return {
      test: client.pipe(
        Effect.flatMap((c) => c.viewer),
        Effect.map((name) => `Authenticated as ${name}`)
      ),
      fetchPage: (request) => client.pipe(Effect.flatMap((c) => c.issues(settings, request)))
    }
  }
}
