import { Data } from "effect"

export class NotFound extends Data.TaggedError("NotFound")<{ readonly entity: string; readonly id: string }> {
  override get message() {
    return `${this.entity} ${this.id} not found`
  }
}

export class Conflict extends Data.TaggedError("Conflict")<{ readonly message: string }> {}

export class BadRequest extends Data.TaggedError("BadRequest")<{
  readonly message: string
  readonly details?: unknown
}> {}

export class DbError extends Data.TaggedError("DbError")<{ readonly message: string; readonly cause?: unknown }> {}
