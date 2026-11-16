import type { AgentEvent, ApprovalDecision, HarnessDetection, HarnessId, PermissionMode } from "@agentdesk/contracts"
import type { Effect, Scope, Stream } from "effect"
import type { HarnessError } from "./errors"

export interface RunPolicy {
  readonly permissionMode: PermissionMode
  /** Environment variables passed to the harness. Secrets (Jira/Git tokens) must not be included. */
  readonly env?: Readonly<Record<string, string>>
  readonly model?: string
  /** Extra system prompt appended to the harness' default. */
  readonly appendSystemPrompt?: string
}

export interface StartInput {
  readonly cwd: string
  readonly policy: RunPolicy
  /** Optional first prompt. If omitted the session is idle until `prompt` is called. */
  readonly prompt?: string
}

export interface ResumeInput extends StartInput {
  readonly providerSessionId: string
}

/**
 * A live, long-running harness session. All resources (child processes, HTTP
 * event streams) are bound to the `Scope` the session was started in: closing
 * the scope terminates the harness.
 */
export interface HarnessSession {
  readonly harness: HarnessId
  /** Provider conversation id (Claude session_id / Codex thread id / OpenCode session id), once known. */
  readonly providerSessionId: Effect.Effect<string | undefined>
  /** OS process id of the harness process, if any. */
  readonly pid: number | undefined
  /** Canonical events. Single consumer; ends when the harness exits. */
  readonly events: Stream.Stream<AgentEvent, HarnessError>
  readonly prompt: (text: string) => Effect.Effect<void, HarnessError>
  readonly respondToApproval: (
    providerRequestId: string,
    decision: ApprovalDecision,
    note?: string
  ) => Effect.Effect<void, HarnessError>
  readonly interrupt: Effect.Effect<void, HarnessError>
}

export interface HarnessAdapter {
  readonly id: HarnessId
  readonly displayName: string
  readonly detect: Effect.Effect<HarnessDetection>
  readonly start: (input: StartInput) => Effect.Effect<HarnessSession, HarnessError, Scope.Scope>
  readonly resume?: (input: ResumeInput) => Effect.Effect<HarnessSession, HarnessError, Scope.Scope>
}
