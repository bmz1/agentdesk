import type { HarnessError } from "@agentdesk/harness-core"
import type { GitError, PullRequestError } from "@agentdesk/git"
import type { TaskSourceError } from "@agentdesk/task-source"
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

/** A save based on an outdated read: the file changed on disk since `baseVersion`. */
export class StaleFile extends Schema.TaggedError<StaleFile>()("StaleFile", {
  path: Schema.String,
  version: Schema.String
}) {
  override get message() {
    return `${this.path} changed on disk since it was opened`
  }
}

export class DbError extends Schema.TaggedError<DbError>()("DbError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** Every expected (typed) failure a daemon operation can produce. */
export type AppError =
  | NotFound
  | Conflict
  | BadRequest
  | StaleFile
  | DbError
  | HarnessError
  | GitError
  | PullRequestError
  | TaskSourceError
  | WorkflowValidationError
  | Schema.SchemaError
