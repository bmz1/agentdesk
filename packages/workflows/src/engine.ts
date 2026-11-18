import type { ExecutionPlan } from "./plan"

/** Minimal persisted view of a step attempt the transition function needs. */
export interface StepAttempt {
  readonly stepIndex: number
  readonly attempt: number
  readonly state: "pending" | "running" | "waiting_for_approval" | "completed" | "failed" | "skipped" | "cancelled" | "interrupted"
}

export type NextAction =
  | { readonly type: "run"; readonly stepIndex: number; readonly attempt: number; readonly retryOf?: number }
  | { readonly type: "wait" }
  | { readonly type: "complete" }
  | { readonly type: "fail"; readonly reason: string }

const attemptsOf = (attempts: ReadonlyArray<StepAttempt>, stepIndex: number) => attempts.filter((a) => a.stepIndex === stepIndex).length

/**
 * Pure workflow state transition: given the plan and the ordered history of
 * step attempts, decide what happens next. Used for normal progress, retries
 * (bounded by `maxAttempts` of the failing step) and crash recovery
 * (an `interrupted`/`running` attempt is re-run as a new attempt).
 */
export const nextAction = (plan: ExecutionPlan, attempts: ReadonlyArray<StepAttempt>): NextAction => {
  const last = attempts.at(-1)
  if (!last) return { type: "run", stepIndex: 0, attempt: 1 }
  const step = plan.steps[last.stepIndex]
  if (!step) return { type: "fail", reason: `Unknown step index ${last.stepIndex}` }
  switch (last.state) {
    case "waiting_for_approval":
    case "pending":
      return { type: "wait" }
    case "running":
    case "interrupted":
      return { type: "run", stepIndex: last.stepIndex, attempt: attemptsOf(attempts, last.stepIndex) + 1 }
    case "completed":
    case "skipped": {
      const next = last.stepIndex + 1
      if (next >= plan.steps.length) return { type: "complete" }
      return { type: "run", stepIndex: next, attempt: attemptsOf(attempts, next) + 1 }
    }
    case "cancelled":
      return { type: "fail", reason: "Cancelled" }
    case "failed": {
      const failures = attempts.filter((a) => a.stepIndex === last.stepIndex && a.state === "failed").length
      if (step.retryStepIndex !== undefined && failures < step.maxAttempts) {
        return {
          type: "run",
          stepIndex: step.retryStepIndex,
          attempt: attemptsOf(attempts, step.retryStepIndex) + 1,
          retryOf: last.stepIndex
        }
      }
      return {
        type: "fail",
        reason: step.retryStepIndex !== undefined ? `Step "${step.id}" failed after ${failures} attempt(s)` : `Step "${step.id}" failed`
      }
    }
  }
}
