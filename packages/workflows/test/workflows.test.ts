import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { compileWorkflow, type ExecutionPlan, nextAction, type StepAttempt } from "../src"

const root = join(__dirname, "../../..")
const resolvePrompt = (p: string) => {
  try {
    return readFileSync(join(root, "prompts", p), "utf8")
  } catch {
    return undefined
  }
}
const compile = (yaml: string) => compileWorkflow(yaml, { resolvePrompt })
const errorsOf = (yaml: string) =>
  compileWorkflow(yaml, { resolvePrompt }).pipe(
    Effect.flip,
    Effect.map((e) => e.errors.join("\n"))
  )

describe("workflow compilation", () => {
  it.effect("compiles the built-in workflows", () =>
    Effect.gen(function* () {
      const plan = yield* compile(readFileSync(join(root, "workflows/plan-implement-test-pr.yaml"), "utf8"))
      expect(plan.steps.map((s) => `${s.id}:${s.kind}`)).toEqual([
        "plan:agent",
        "approve_plan:approval",
        "implement:agent",
        "test:command",
        "review:agent",
        "draft_pr:pull_request"
      ])
      expect(plan.steps[0]!.promptText).toContain("implementation plan")
      expect(plan.steps[3]).toMatchObject({ retryStep: "implement", retryStepIndex: 2, maxAttempts: 2 })
      expect(plan.steps[5]).toMatchObject({ draft: true, requiresApproval: true })
      yield* compile(readFileSync(join(root, "workflows/quick-fix.yaml"), "utf8"))
    })
  )

  it.effect("rejects invalid definitions with typed WorkflowValidationError", () =>
    Effect.gen(function* () {
      expect(yield* errorsOf("id: x\nversion: 1\nname: x\nsteps: []")).toMatch(/at least 1|minLength|length/i)
      expect(yield* errorsOf("id: x\nversion: 1\nname: x\nsteps:\n  - id: a\n    kind: teleport")).not.toBe("")
      expect(
        yield* errorsOf(
          "id: x\nversion: 1\nname: x\nsteps:\n  - id: a\n    kind: agent\n    instructions: hi\n  - id: a\n    kind: command\n    onFailure: { retryStep: zzz }"
        )
      ).toMatch(/Duplicate step id.*retryStep "zzz" does not exist|Duplicate/)
      expect(yield* errorsOf("id: x\nversion: 1\nname: x\nsteps:\n  - id: a\n    kind: agent\n    prompt: missing.md")).toContain(
        "not found"
      )
      expect(
        yield* errorsOf("id: x\nversion: 1\nname: x\nsteps:\n  - id: a\n    kind: approval\n    artifact: artifacts/plan.md")
      ).toContain("not produced")
      expect(yield* errorsOf("id: x\nversion: 1\nname: x\nsteps: [\n")).toContain("Invalid YAML")
    })
  )
})

describe("nextAction", () => {
  let plan: ExecutionPlan
  const a = (stepIndex: number, attempt: number, state: StepAttempt["state"]): StepAttempt => ({ stepIndex, attempt, state })

  it.effect("walks steps, waits on approvals, retries within bounds and fails after", () =>
    Effect.gen(function* () {
      plan = yield* compile(readFileSync(join(root, "workflows/plan-implement-test-pr.yaml"), "utf8"))
      expect(nextAction(plan, [])).toEqual({ type: "run", stepIndex: 0, attempt: 1 })
      expect(nextAction(plan, [a(0, 1, "completed")])).toEqual({ type: "run", stepIndex: 1, attempt: 1 })
      expect(nextAction(plan, [a(0, 1, "completed"), a(1, 1, "waiting_for_approval")])).toEqual({ type: "wait" })
      // Plan rejected → re-plan.
      expect(nextAction(plan, [a(0, 1, "completed"), a(1, 1, "failed")])).toMatchObject({
        type: "run",
        stepIndex: 0,
        attempt: 2,
        retryOf: 1
      })
      // Tests fail once → back to implement; fail twice → run fails.
      const base = [a(0, 1, "completed"), a(1, 1, "completed"), a(2, 1, "completed")]
      expect(nextAction(plan, [...base, a(3, 1, "failed")])).toMatchObject({ type: "run", stepIndex: 2, attempt: 2 })
      expect(nextAction(plan, [...base, a(3, 1, "failed"), a(2, 2, "completed")])).toMatchObject({ type: "run", stepIndex: 3, attempt: 2 })
      expect(nextAction(plan, [...base, a(3, 1, "failed"), a(2, 2, "completed"), a(3, 2, "failed")])).toMatchObject({ type: "fail" })
      // Crash recovery re-runs the interrupted step as a new attempt.
      expect(nextAction(plan, [...base, a(3, 1, "interrupted")])).toEqual({ type: "run", stepIndex: 3, attempt: 2 })
      expect(nextAction(plan, [...base, a(3, 1, "completed"), a(4, 1, "completed"), a(5, 1, "completed")])).toEqual({ type: "complete" })
    })
  )
})
