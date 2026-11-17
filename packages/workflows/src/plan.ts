import type { HarnessId } from "@agentdesk/contracts"
import { Effect, Schema } from "effect"
import { parse as parseYaml } from "yaml"
import { type StepDefinition, WorkflowDefinition } from "./dsl"

/** Stable, fully-resolved execution plan stored with each workflow version. */
export interface PlanStep {
  readonly index: number
  readonly id: string
  readonly name: string
  readonly kind: StepDefinition["kind"]
  readonly harness?: HarnessId
  readonly promptText?: string
  readonly output?: string
  readonly context: ReadonlyArray<string>
  readonly artifact?: string
  readonly title?: string
  readonly command?: string
  readonly draft: boolean
  readonly requiresApproval: boolean
  readonly retryStep?: string
  readonly retryStepIndex?: number
  readonly maxAttempts: number
  readonly timeoutSec?: number
}

export interface ExecutionPlan {
  readonly id: string
  readonly version: number
  readonly name: string
  readonly description?: string
  readonly steps: ReadonlyArray<PlanStep>
}

export class WorkflowValidationError extends Schema.TaggedError<WorkflowValidationError>()("WorkflowValidationError", {
  errors: Schema.Array(Schema.String)
}) {
  override get message() {
    return this.errors.join("; ")
  }
}

export interface CompileOptions {
  /** Resolve a `prompt:` path to its text. Return undefined if missing. */
  readonly resolvePrompt?: (path: string) => string | undefined
}

const DEFAULT_NAMES: Record<StepDefinition["kind"], string> = {
  agent: "Agent",
  approval: "Approval",
  command: "Command",
  pull_request: "Draft pull request"
}

const humanize = (id: string, kind: StepDefinition["kind"]) => {
  if (kind === "pull_request") return DEFAULT_NAMES.pull_request
  const words = id.replace(/[_-]+/g, " ").trim()
  return words ? words[0]!.toUpperCase() + words.slice(1) : DEFAULT_NAMES[kind]
}

/** Parse + validate YAML and compile it into an ExecutionPlan. */
export const compileWorkflow = (yaml: string, options: CompileOptions = {}): Effect.Effect<ExecutionPlan, WorkflowValidationError> =>
  Effect.gen(function* () {
    let raw: unknown
    try {
      raw = parseYaml(yaml)
    } catch (e) {
      return yield* Effect.fail(new WorkflowValidationError({ errors: [`Invalid YAML: ${(e as Error).message}`] }))
    }
    const def = yield* Schema.decodeUnknownEffect(WorkflowDefinition)(raw).pipe(
      Effect.mapError((e) => new WorkflowValidationError({ errors: [e.message] }))
    )
    const errors: Array<string> = []
    const index = new Map<string, number>()
    def.steps.forEach((s, i) => {
      if (index.has(s.id)) errors.push(`Duplicate step id "${s.id}"`)
      index.set(s.id, i)
    })
    const produced = new Set<string>()
    const steps = def.steps.map((s, i): PlanStep => {
      const retryStep = s.onFailure?.retryStep
      const retryStepIndex = retryStep !== undefined ? index.get(retryStep) : undefined
      if (retryStep !== undefined) {
        if (retryStepIndex === undefined) errors.push(`Step "${s.id}": retryStep "${retryStep}" does not exist`)
        else if (retryStepIndex > i) errors.push(`Step "${s.id}": retryStep "${retryStep}" must not come after it`)
      }
      let promptText: string | undefined
      if (s.kind === "agent") {
        if (s.prompt) {
          promptText = options.resolvePrompt?.(s.prompt)
          if (promptText === undefined) errors.push(`Step "${s.id}": prompt file "${s.prompt}" not found`)
        } else promptText = s.instructions
        if (!promptText) errors.push(`Step "${s.id}": agent steps need a prompt or instructions`)
        for (const c of s.context ?? []) if (!produced.has(c)) errors.push(`Step "${s.id}": context "${c}" is not produced by an earlier step`)
        if (s.output) produced.add(s.output)
      }
      if (s.kind === "approval" && s.artifact && !produced.has(s.artifact)) {
        errors.push(`Step "${s.id}": artifact "${s.artifact}" is not produced by an earlier step`)
      }
      return {
        index: i,
        id: s.id,
        name: s.name ?? ((s.kind === "approval" || s.kind === "pull_request") && s.title ? s.title : humanize(s.id, s.kind)),
        kind: s.kind,
        harness: s.kind === "agent" ? s.harness : undefined,
        promptText,
        output: s.kind === "agent" ? s.output : undefined,
        context: s.kind === "agent" ? (s.context ?? []) : [],
        artifact: s.kind === "approval" ? s.artifact : undefined,
        title: s.kind === "approval" || s.kind === "pull_request" ? s.title : undefined,
        command: s.kind === "command" ? s.command : undefined,
        draft: s.kind === "pull_request" ? (s.draft ?? true) : false,
        requiresApproval: s.kind === "pull_request" ? (s.requiresApproval ?? true) : false,
        retryStep,
        retryStepIndex,
        maxAttempts: s.onFailure?.maxAttempts ?? 1,
        timeoutSec: s.timeoutSec
      }
    })
    if (errors.length > 0) return yield* Effect.fail(new WorkflowValidationError({ errors }))
    return { id: def.id, version: def.version, name: def.name, description: def.description, steps }
  })
