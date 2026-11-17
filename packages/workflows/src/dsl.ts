import { HarnessId } from "@agentdesk/contracts"
import { Schema } from "effect"

/**
 * AgentDesk workflow DSL (app-specific; not a Cezar or Effect format).
 * Parsed from YAML, validated with Effect Schema, then compiled into an
 * immutable ExecutionPlan that runs pin.
 */
const Id = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/))

const OnFailure = Schema.Struct({
  retryStep: Schema.optional(Id),
  maxAttempts: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 10 })))
})

const Base = {
  id: Id,
  name: Schema.optional(Schema.String),
  onFailure: Schema.optional(OnFailure),
  timeoutSec: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0)))
}

export const AgentStep = Schema.Struct({
  ...Base,
  kind: Schema.Literal("agent"),
  harness: Schema.optional(HarnessId),
  /** Path to a prompt file (relative to the prompts directory) — or use `instructions`. */
  prompt: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  /** Artifact path written from the agent's final message, e.g. artifacts/plan.md */
  output: Schema.optional(Schema.String),
  /** Artifacts from earlier steps injected into the prompt. */
  context: Schema.optional(Schema.Array(Schema.String))
})

export const ApprovalStep = Schema.Struct({
  ...Base,
  kind: Schema.Literal("approval"),
  artifact: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String)
})

export const CommandStep = Schema.Struct({
  ...Base,
  kind: Schema.Literal("command"),
  /** Shell command run in the worktree. Defaults to the project's test command. */
  command: Schema.optional(Schema.String)
})

export const PullRequestStep = Schema.Struct({
  ...Base,
  kind: Schema.Literal("pull_request"),
  draft: Schema.optional(Schema.Boolean),
  requiresApproval: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String)
})

export const StepDefinition = Schema.Union([AgentStep, ApprovalStep, CommandStep, PullRequestStep])
export type StepDefinition = typeof StepDefinition.Type

export const WorkflowDefinition = Schema.Struct({
  id: Id,
  version: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  steps: Schema.Array(StepDefinition).check(Schema.isMinLength(1))
})
export type WorkflowDefinition = typeof WorkflowDefinition.Type
