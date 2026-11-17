import { basename, isAbsolute, relative, resolve } from "node:path"
import type { AgentEvent, StoredAgentEvent } from "@agentdesk/contracts"
import type { WorktreeEntry } from "@agentdesk/git"
import type { RunPolicy } from "@agentdesk/harness-core"

/**
 * Read-only threads run in the project's main checkout. The agent may look around freely, but
 * must create its own git worktree before changing code. AgentDesk then infers which worktree
 * it created and adopts it, so the diff, review and PR flows work as for any other ticket.
 */
export const readOnlyInstructions = (repoPath: string) =>
  [
    `You are running in the user's main checkout at ${repoPath}, in read-only mode.`,
    "Reading, searching and running non-mutating commands is fine. Do not modify files in this checkout:",
    "edits here are rejected automatically.",
    "If the task needs code changes, first create a git worktree on a new branch (for example",
    "`git worktree add ../<name> -b <branch>`), then make all edits and run all mutating commands inside it.",
    "Mention the worktree path in your reply."
  ].join(" ")

/** Read-only threads always ask: edits must surface as approvals so the main checkout can be guarded. */
export const readOnlyPolicy = (policy: RunPolicy, repoPath: string): RunPolicy => {
  const { sandboxPrefix: _ignored, ...rest } = policy
  return {
    ...rest,
    permissionMode: policy.permissionMode === "plan" ? "plan" : "ask",
    appendSystemPrompt: [policy.appendSystemPrompt, readOnlyInstructions(repoPath)].filter(Boolean).join("\n\n")
  }
}

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "patch", "apply_patch"])

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

const strings = (v: unknown): Array<string> =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/**
 * Files an approval request would change, resolved against the session's cwd.
 * `paths` is empty when the harness does not report them (Codex file changes).
 */
export const editTargets = (
  event: Extract<AgentEvent, { type: "approval.requested" }>,
  cwd: string
): { readonly edit: boolean; readonly paths: ReadonlyArray<string> } => {
  if (!EDIT_TOOLS.has(event.toolName.toLowerCase())) return { edit: false, paths: [] }
  const details = asRecord(event.details) ?? {}
  const input = asRecord(details.input) ?? {}
  const raw = [
    ...strings(input.file_path),
    ...strings(input.notebook_path),
    ...strings(details.file_path),
    ...strings(details.patterns),
    ...strings(details.resources)
  ].filter((p) => p && p !== "*")
  return { edit: true, paths: raw.map((p) => (isAbsolute(p) ? p : resolve(cwd, p))) }
}

export const isInside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** True when the path would change the main checkout itself rather than a linked worktree (e.g. `.claude/worktrees/x`). */
export const touchesMainCheckout = (path: string, repoPath: string, worktreePaths: ReadonlyArray<string>) =>
  isInside(path, repoPath) && !worktreePaths.some((w) => isInside(path, w))

/** The agent's own actions in a session: tool inputs and results, where a `git worktree add` would appear. */
export const actionText = (history: ReadonlyArray<StoredAgentEvent>) =>
  history
    .map(({ event }) =>
      event.type === "tool.started"
        ? JSON.stringify(event.input ?? "")
        : event.type === "tool.completed"
          ? JSON.stringify(event.result ?? "")
          : event.type === "message.completed"
            ? event.text
            : ""
    )
    .join("\n")

const mentions = (text: string, w: WorktreeEntry) => {
  const name = basename(w.path)
  return text.includes(w.path) || (name.length >= 3 && text.includes(name)) || (!!w.branch && text.includes(w.branch))
}

/**
 * Which new worktree (if any) a read-only session created. Prefers one its tool calls mention;
 * otherwise, with a start-of-session snapshot, a single new worktree is unambiguous unless
 * another read-only session in the same repo could have created it.
 */
export const inferCreatedWorktree = (args: {
  readonly candidates: ReadonlyArray<WorktreeEntry>
  readonly actions: string
  readonly hasSnapshot: boolean
  readonly otherReadOnlySessions: number
}): WorktreeEntry | undefined => {
  const mentioned = args.candidates.filter((w) => mentions(args.actions, w))
  if (mentioned.length > 0) return mentioned[mentioned.length - 1]
  if (args.hasSnapshot && args.candidates.length === 1 && args.otherReadOnlySessions === 0) return args.candidates[0]
  return undefined
}
