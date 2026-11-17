import { Clock, Duration, Effect, Redacted, Schedule, Schema } from "effect"
import { adfToText } from "./adf"

export type JiraDeployment = "cloud" | "datacenter"

export class JiraError extends Schema.TaggedError<JiraError>()("JiraError", {
  kind: Schema.Literals(["auth", "rate_limited", "http", "network", "invalid_response", "config"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  retryAfterMs: Schema.optional(Schema.Number)
}) {}

export interface JiraClientConfig {
  readonly deployment: JiraDeployment
  readonly baseUrl: string
  /** Email (Cloud basic auth) or username (DC; unused with PAT bearer). */
  readonly principal: string
  readonly token: Redacted.Redacted<string>
  readonly fetch?: typeof globalThis.fetch
  readonly pageSize?: number
  readonly maxRetries?: number
  /** Base delay for retry backoff (tests use ~1ms). */
  readonly retryBaseMs?: number
}

const NullableName = Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) }))
const IssueFields = Schema.Struct({
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.Unknown),
  status: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        statusCategory: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.optional(Schema.String) })))
      })
    )
  ),
  assignee: Schema.optional(Schema.NullOr(Schema.Struct({ displayName: Schema.optional(Schema.String) }))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  priority: Schema.optional(NullableName),
  updated: Schema.optional(Schema.NullOr(Schema.String)),
  issuetype: Schema.optional(NullableName)
})
export const JiraIssuePayload = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  fields: IssueFields
})
export type JiraIssuePayload = typeof JiraIssuePayload.Type

const CloudPage = Schema.Struct({
  issues: Schema.Array(JiraIssuePayload),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
  isLast: Schema.optional(Schema.Boolean)
})
const DcPage = Schema.Struct({
  issues: Schema.Array(JiraIssuePayload),
  startAt: Schema.Number,
  maxResults: Schema.Number,
  total: Schema.Number
})

/** Normalized issue — the only shape the rest of AgentDesk sees. */
export interface JiraIssue {
  readonly id: string
  readonly key: string
  readonly url: string
  readonly title: string
  readonly description: string
  readonly status: string | null
  readonly statusCategory: "new" | "indeterminate" | "done" | null
  readonly assignee: string | null
  readonly labels: ReadonlyArray<string>
  readonly priority: string | null
  readonly updated: string | null
  readonly issueType: string | null
}

export interface JiraPage {
  readonly issues: ReadonlyArray<JiraIssue>
  readonly cursor: string | undefined
}

export const FIELDS = ["summary", "description", "status", "assignee", "labels", "priority", "updated", "issuetype"]

export const normalizeIssue = (baseUrl: string, raw: JiraIssuePayload): JiraIssue => {
  const cat = raw.fields.status?.statusCategory?.key
  return {
    id: raw.id,
    key: raw.key,
    url: `${baseUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(raw.key)}`,
    title: raw.fields.summary ?? raw.key,
    description: adfToText(raw.fields.description),
    status: raw.fields.status?.name ?? null,
    statusCategory: cat === "new" || cat === "indeterminate" || cat === "done" ? cat : null,
    assignee: raw.fields.assignee?.displayName ?? null,
    labels: raw.fields.labels ?? [],
    priority: raw.fields.priority?.name ?? null,
    updated: raw.fields.updated ?? null,
    issueType: raw.fields.issuetype?.name ?? null
  }
}

const parseRetryAfter = (h: string | null, nowMs: number): number | undefined => {
  if (!h) return undefined
  const s = Number(h)
  if (Number.isFinite(s)) return s * 1000
  const d = Date.parse(h)
  return Number.isFinite(d) ? Math.max(0, d - nowMs) : undefined
}

export interface JiraClient {
  /** Fetch one page of issues for a JQL query. `cursor` is opaque (nextPageToken or startAt). */
  readonly searchPage: (jql: string, cursor?: string) => Effect.Effect<JiraPage, JiraError>
  /** Fetch all pages (bounded by `maxIssues`). */
  readonly searchAll: (jql: string, maxIssues?: number) => Effect.Effect<ReadonlyArray<JiraIssue>, JiraError>
  /** Verify credentials (`/myself`). */
  readonly myself: Effect.Effect<{ displayName: string }, JiraError>
}

export const makeJiraClient = (config: JiraClientConfig): JiraClient => {
  const doFetch = config.fetch ?? globalThis.fetch
  const base = config.baseUrl.replace(/\/+$/, "")
  const pageSize = config.pageSize ?? 50
  const api = config.deployment === "cloud" ? "/rest/api/3" : "/rest/api/2"
  const authHeader =
    config.deployment === "cloud"
      ? `Basic ${Buffer.from(`${config.principal}:${Redacted.value(config.token)}`).toString("base64")}`
      : `Bearer ${Redacted.value(config.token)}`

  const request = (method: "GET" | "POST", path: string, body?: unknown) =>
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: (signal) =>
          doFetch(`${base}${path}`, {
            method,
            signal,
            headers: {
              Authorization: authHeader,
              Accept: "application/json",
              ...(body !== undefined && { "Content-Type": "application/json" })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
          }),
        catch: (e) => new JiraError({ kind: "network", message: `Jira unreachable: ${String(e)}` })
      })
      if (res.status === 401 || res.status === 403) {
        return yield* new JiraError({ kind: "auth", status: res.status, message: `Jira rejected credentials (${res.status})` })
      }
      if (res.status === 429) {
        return yield* new JiraError({
          kind: "rate_limited",
          status: 429,
          message: "Jira rate limit hit",
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), yield* Clock.currentTimeMillis)
        })
      }
      if (!res.ok) {
        const text = yield* Effect.promise(() => res.text().catch(() => ""))
        return yield* new JiraError({ kind: "http", status: res.status, message: `Jira ${res.status}: ${text.slice(0, 300)}` })
      }
      return yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: () => new JiraError({ kind: "invalid_response", message: "Jira returned invalid JSON" })
      })
    })

  const retryable = (e: JiraError) => e.kind === "rate_limited" || e.kind === "network" || (e.kind === "http" && (e.status ?? 0) >= 500)
  const baseMs = config.retryBaseMs ?? 500
  const withRetry = <A>(eff: Effect.Effect<A, JiraError>) =>
    eff.pipe(
      Effect.tapError((e) =>
        e.kind === "rate_limited" && e.retryAfterMs ? Effect.sleep(Duration.millis(Math.min(e.retryAfterMs, 60_000))) : Effect.void
      ),
      Effect.retry({
        while: retryable,
        times: config.maxRetries ?? 4,
        schedule: Schedule.exponential(Duration.millis(baseMs), 2)
      })
    )

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, u: unknown) =>
    Schema.decodeUnknownEffect(schema)(u).pipe(
      Effect.mapError((e) => new JiraError({ kind: "invalid_response", message: `Unexpected Jira payload: ${e.message.slice(0, 300)}` }))
    ) as Effect.Effect<S["Type"], JiraError>

  const searchPage = (jql: string, cursor?: string): Effect.Effect<JiraPage, JiraError> =>
    searchPageUntraced(jql, cursor).pipe(
      Effect.withSpan("JiraClient.searchPage", { attributes: { deployment: config.deployment, page: cursor ?? "first" } })
    )

  const searchPageUntraced = (jql: string, cursor?: string): Effect.Effect<JiraPage, JiraError> =>
    config.deployment === "cloud"
      ? withRetry(
          request("POST", `${api}/search/jql`, {
            jql,
            maxResults: pageSize,
            fields: FIELDS,
            ...(cursor && { nextPageToken: cursor })
          })
        ).pipe(
          Effect.flatMap((u) => decode(CloudPage, u)),
          Effect.map((p) => ({
            issues: p.issues.map((i) => normalizeIssue(base, i)),
            cursor: p.isLast === true || !p.nextPageToken ? undefined : p.nextPageToken
          }))
        )
      : withRetry(
          request("POST", `${api}/search`, { jql, startAt: Number(cursor ?? 0), maxResults: pageSize, fields: FIELDS })
        ).pipe(
          Effect.flatMap((u) => decode(DcPage, u)),
          Effect.map((p) => {
            const next = p.startAt + p.issues.length
            return {
              issues: p.issues.map((i) => normalizeIssue(base, i)),
              cursor: p.issues.length > 0 && next < p.total ? String(next) : undefined
            }
          })
        )

  const searchAll = (jql: string, maxIssues = 5000) =>
    Effect.gen(function* () {
      const all: Array<JiraIssue> = []
      let cursor: string | undefined
      do {
        const page = yield* searchPage(jql, cursor)
        all.push(...page.issues)
        cursor = page.cursor
      } while (cursor && all.length < maxIssues)
      return all
    })

  return {
    searchPage,
    searchAll,
    myself: withRetry(request("GET", `${api}/myself`)).pipe(
      Effect.map((u) => ({ displayName: String((u as { displayName?: unknown })?.displayName ?? "unknown") }))
    )
  }
}

/** Jira JQL datetime literal (minute precision). Interpreted in the Jira user's timezone. */
export const jqlDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

/** Restrict a user JQL to issues updated since a watermark, preserving its ORDER BY. */
export const incrementalJql = (jql: string, since: Date) => {
  const m = /\s+order\s+by\s+.+$/i.exec(jql)
  const where = m ? jql.slice(0, m.index) : jql
  const order = m ? m[0] : " ORDER BY updated ASC"
  return `(${where.trim()}) AND updated >= "${jqlDate(since)}"${order}`
}
