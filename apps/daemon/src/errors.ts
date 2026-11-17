import type { HarnessError } from "@agentdesk/harness-core"
import type { GitError, PullRequestError } from "@agentdesk/git"
import type { JiraError } from "@agentdesk/jira"
import type { WorkflowValidationError } from "@agentdesk/workflows"
import { Schema } from "effect"

export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String
}) {
  override get message() {
    return `${this.entity} ${this.id} not found`
  }
}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String
}) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
  details: Schema.optional(Schema.Unknown)
}) {}

export class DbError extends Schema.TaggedError<DbError>()("DbError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** Every expected (typed) failure a daemon operation can produce. */
export type AppError =
  | NotFound
  | Conflict
  | BadRequest
  | DbError
  | HarnessError
  | GitError
  | PullRequestError
  | JiraError
  | WorkflowValidationError
  | Schema.SchemaError
