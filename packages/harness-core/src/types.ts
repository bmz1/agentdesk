import type {
  AgentEvent,
  ApprovalDecision,
  HarnessCapabilities,
  HarnessDetection,
  HarnessId,
  PermissionMode,
  QuestionAnswers
} from "@agentdesk/contracts"
import type { Effect, Scope, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { HarnessError } from "./errors"

export interface RunPolicy {
  readonly permissionMode: PermissionMode
  /** Environment variables passed to the harness. Secrets (Jira/Git tokens) must not be included. */
  readonly env?: Readonly<Record<string, string>>
  readonly model?: string
  /** Reasoning effort level (harness-specific values such as low/medium/high). */
  readonly effort?: string
  /** Extra system prompt appended to the harness' default. */
  readonly appendSystemPrompt?: string
  /**
   * Command prefix that confines the harness process (e.g. a container or
   * bubblewrap invocation). Required for unrestricted permission mode.
   */
  readonly sandboxPrefix?: ReadonlyArray<string>
}

/** An image attached to a prompt: inline for harnesses that take bytes, a path for those that read files. */
export interface PromptImage {
  readonly mimeType: string
  /** Base64 contents. */
  readonly data: string
  /** Absolute path of the same image on disk. */
  readonly path: string
}

export interface PromptOptions {
  readonly model?: string
  readonly effort?: string
}

/** The user's answer to an approval or question request. */
export interface ApprovalResponse {
  readonly decision: ApprovalDecision
  readonly note?: string
  /** "session": allow matching requests for the rest of the session (when the request said it can). */
  readonly scope?: "once" | "session"
  /** For question requests: answers keyed by question id. */
  readonly answers?: QuestionAnswers
}

export interface StartInput {
  readonly cwd: string
  readonly policy: RunPolicy
  /** Optional first prompt. If omitted the session is idle until `prompt` is called. */
  readonly prompt?: string
  /** Images sent with the first prompt. */
  readonly images?: ReadonlyArray<PromptImage>
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
  /** Send a prompt. `options.model` switches the model from this turn on (undefined keeps the current one). */
  readonly prompt: (text: string, images?: ReadonlyArray<PromptImage>, options?: PromptOptions) => Effect.Effect<void, HarnessError>
  readonly respondToApproval: (providerRequestId: string, response: ApprovalResponse) => Effect.Effect<void, HarnessError>
  readonly interrupt: Effect.Effect<void, HarnessError>
  /** False when an effort change needs a new process (resumed with the new effort). Default true. */
  readonly liveEffort?: boolean
}

/** Services a harness may use: its owning scope and the platform process spawner. */
export type HarnessRequirements = Scope.Scope | ChildProcessSpawner.ChildProcessSpawner

export interface HarnessAdapter {
  readonly id: HarnessId
  readonly displayName: string
  readonly capabilities: HarnessCapabilities
  readonly detect: Effect.Effect<HarnessDetection, never, ChildProcessSpawner.ChildProcessSpawner>
  readonly start: (input: StartInput) => Effect.Effect<HarnessSession, HarnessError, HarnessRequirements>
  readonly resume?: (input: ResumeInput) => Effect.Effect<HarnessSession, HarnessError, HarnessRequirements>
}
