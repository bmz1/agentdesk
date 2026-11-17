import { Schema } from "effect"

/** Any failure talking to a harness process or protocol. `reason` drives HTTP status and retry decisions. */
export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  harness: Schema.String,
  reason: Schema.Literals(["not_installed", "spawn_failed", "protocol", "io", "closed", "unsupported", "timeout"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}
