import type { Effect, Redacted } from "effect"
import { Schema } from "effect"

/**
 * A task source is any external system that tickets can be imported from
 * (Jira, Linear, GitHub Issues, …). Sources are read-only: AgentDesk never
 * writes back. Each source is an adapter implementing this contract; the
 * daemon's generic TaskSync service owns everything else (upserts, watermarks,
 * out-of-scope detection, polling, credentials, audit).
 */

/** Board column a newly imported task starts in. Local status is never overwritten afterwards. */
export type StatusCategory = "todo" | "in_progress" | "done"

/** A remote task normalized into the one shape the rest of AgentDesk understands. */
export interface RemoteTask {
  /** Stable, never-reused remote identifier (Jira issue id, Linear issue UUID). */
  readonly remoteId: string
  /** Human key shown on cards (SEON-12, ENG-42). */
  readonly key: string
  /**
   * Remote container the task lives in (Jira project key, Linear team key). Connections are
   * global, so this routes the task to a local project. Defaults to the key's prefix.
   */
  readonly scope?: string
  readonly url: string
  readonly title: string
  /** Plain text / Markdown-ish. Rendered as text, never HTML. */
  readonly description: string
  readonly status: string | null
  readonly statusCategory: StatusCategory | null
  readonly assignee: string | null
  readonly labels: ReadonlyArray<string>
  /** ISO timestamp of the last remote change; drives the incremental watermark. */
  readonly updatedAt: string | null
  /** Provider-specific extras kept for debugging (not used for logic). */
  readonly raw?: Record<string, unknown>
}

export interface FetchPageRequest {
  /** When set, only tasks updated at or after this instant are requested (incremental sync). */
  readonly since?: Date
  /** Opaque cursor returned by the previous page. */
  readonly cursor?: string
}

export interface TaskPage {
  readonly tasks: ReadonlyArray<RemoteTask>
  /** Undefined when this was the last page. */
  readonly cursor: string | undefined
}

export class TaskSourceError extends Schema.TaggedError<TaskSourceError>()("TaskSourceError", {
  source: Schema.String,
  kind: Schema.Literals(["auth", "rate_limited", "http", "network", "invalid_response", "config"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number)
}) {}

/** A connected, configured client for one source connection. */
export interface TaskSourceClient {
  /** Verify credentials and scope; returns a human-readable description of who/what we are connected as. */
  readonly test: Effect.Effect<string, TaskSourceError>
  readonly fetchPage: (request: FetchPageRequest) => Effect.Effect<TaskPage, TaskSourceError>
}

/** Describes one settings field so UIs can render a form for any source. */
export interface SourceField {
  readonly key: string
  readonly label: string
  readonly type: "text" | "url" | "textarea" | "select" | "number"
  readonly required?: boolean
  readonly placeholder?: string
  readonly hint?: string
  readonly default?: string
  readonly options?: ReadonlyArray<{ readonly value: string; readonly label: string }>
}

export interface ConnectOptions {
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: typeof globalThis.fetch
  /** Base delay for retry backoff. */
  readonly retryBaseMs?: number
}

export interface TaskSourceAdapter<Settings = unknown> {
  readonly id: string
  readonly displayName: string
  readonly description: string
  /** Validates and decodes stored/submitted settings (no secrets in here). */
  readonly settings: Schema.Codec<Settings, unknown>
  readonly fields: ReadonlyArray<SourceField>
  readonly credential: { readonly label: string; readonly hint: string; readonly required: boolean }
  /** What a task's `scope` is called in this source ("Jira project", "Linear team"). */
  readonly scopeLabel?: string
  readonly connect: (settings: Settings, credential: Redacted.Redacted<string> | undefined, options?: ConnectOptions) => TaskSourceClient
}

/** Serializable description of a source for API/UI consumers. */
export interface SourceDescriptor {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly fields: ReadonlyArray<SourceField>
  readonly credential: TaskSourceAdapter["credential"]
  readonly scopeLabel: string
}

/** The routing key of a task: its explicit scope, else the prefix of its key (SEON-12 → SEON). */
export const scopeOf = (task: Pick<RemoteTask, "key" | "scope">): string =>
  (task.scope ?? task.key.replace(/-[^-]*$/, "")).trim().toUpperCase()
