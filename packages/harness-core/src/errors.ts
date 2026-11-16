import { Data } from "effect"

export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly harness: string
  readonly reason: "not_installed" | "spawn_failed" | "protocol" | "io" | "closed" | "unsupported" | "timeout"
  readonly message: string
  readonly cause?: unknown
}> {}
