import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import type { HarnessCapabilities, PermissionMode } from "@agentdesk/contracts"
import {
  type ApprovalResponse,
  eventsStream,
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  type PromptImage,
  isRecord,
  type ResumeInput,
  runCommand,
  spawnManaged,
  type StartInput,
  str,
  wireLineProcess
} from "@agentdesk/harness-core"
import { Effect } from "effect"
import { ClaudeNormalizer, QUESTION_TOOL } from "./normalizer"

export interface ClaudeAdapterOptions {
  readonly binary?: string
}

export const permissionFlags = (mode: PermissionMode): Array<string> => {
  switch (mode) {
    case "accept_edits":
      return ["--permission-mode", "acceptEdits"]
    // Claude's classifier approves routine actions and blocks risky ones;
    // only what it escalates reaches AgentDesk as an approval card.
    case "auto":
      return ["--permission-mode", "auto"]
    case "plan":
      return ["--permission-mode", "plan"]
    case "unrestricted":
      return ["--dangerously-skip-permissions"]
    case "ask":
      return []
  }
}

const userMessage = (text: string, images: ReadonlyArray<PromptImage> = []) =>
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })),
        { type: "text", text }
      ]
    }
  }) + "\n"

/** `--model` aliases always resolve to the latest model of that family; full model names also work. */
export const CLAUDE_MODELS = [
  { id: "fable", label: "Fable (latest)" },
  { id: "opus", label: "Opus (latest)" },
  { id: "sonnet", label: "Sonnet (latest)" },
  { id: "haiku", label: "Haiku (latest)" }
]

/** `claude --effort` levels. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]

/** Arguments that make the CLI answer `initialize` and exit at end of input, without hooks or a saved session. */
export const CLAUDE_MODEL_PROBE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--settings",
  JSON.stringify({ disableAllHooks: true })
]
export const CLAUDE_MODEL_PROBE_INPUT =
  JSON.stringify({ type: "control_request", request_id: "agentdesk-models", request: { subtype: "initialize" } }) + "\n"

/**
 * The models the installed CLI offers this account, with exact names ("Opus 5.5") and their effort
 * levels, from its `initialize` response. "default" is left out (AgentDesk's own "Default" option means
 * the same) but named as the default. Undefined when the output has no model list.
 */
export const parseClaudeModels = (stdout: string) => {
  for (const line of stdout.split("\n")) {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(msg) || msg.type !== "control_response" || !isRecord(msg.response)) continue
    const response = msg.response.response
    if (!isRecord(response) || !Array.isArray(response.models)) continue
    const entries = response.models.filter(isRecord)
    const levels = (m: Record<string, unknown>) =>
      Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((l): l is string => typeof l === "string") : []
    const models = entries.flatMap((m) => {
      const id = str(m.value)
      if (!id || id === "default") return []
      const efforts = levels(m)
      return [{ id, label: str(m.displayName) ?? id, ...(efforts.length && { efforts }) }]
    })
    if (models.length === 0) return undefined
    const fallback = entries.find((m) => m.value === "default")
    const resolved = fallback && str(fallback.resolvedModel)
    const defaultModel = resolved ? entries.find((m) => m.value !== "default" && str(m.resolvedModel) === resolved) : undefined
    return { models, defaultModel: defaultModel ? str(defaultModel.displayName) : undefined }
  }
  return undefined
}

export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  planMode: "native",
  acceptEdits: "native",
  liveEffort: false,
  allowForSession: true,
  questions: true,
  cost: true,
  rateLimits: true
}

interface PendingRequest {
  readonly toolName: string | undefined
  readonly input: unknown
  /** Permission updates Claude proposes for "always allow" (e.g. accept edits for the session). */
  readonly suggestions: ReadonlyArray<unknown>
}

/**
 * The `control_response` that answers a `can_use_tool` request. Questions are answered by
 * allowing the tool with the answers added to its input, keyed by question text.
 */
export const claudeApprovalResponse = (pending: PendingRequest | undefined, r: ApprovalResponse) => {
  if (r.decision === "deny") {
    return { behavior: "deny", message: r.note ?? (pending?.toolName === QUESTION_TOOL ? "The user chose not to answer." : "Denied by the user in AgentDesk") }
  }
  const input = (pending?.input ?? {}) as Record<string, unknown>
  if (pending?.toolName === QUESTION_TOOL) {
    const answers = Object.fromEntries(Object.entries(r.answers ?? {}).map(([q, a]) => [q, a.join(", ")]))
    return { behavior: "allow", updatedInput: { ...input, answers } }
  }
  return {
    behavior: "allow",
    updatedInput: input,
    ...(r.scope === "session" && pending?.suggestions.length && { updatedPermissions: pending.suggestions })
  }
}

export const makeClaudeAdapter = (options: ClaudeAdapterOptions = {}): HarnessAdapter => {
  const resolveBinary = () => options.binary ?? process.env.AGENTDESK_CLAUDE_BIN ?? findExecutable("claude")

  const launch = (input: StartInput & { providerSessionId?: string }) =>
    Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) {
        return yield* new HarnessError({ harness: "claude", reason: "not_installed", message: "claude CLI not found on PATH" })
      }
      const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        ...permissionFlags(input.policy.permissionMode),
        ...(input.policy.model ? ["--model", input.policy.model] : []),
        ...(input.policy.effort ? ["--effort", input.policy.effort] : []),
        ...(input.policy.appendSystemPrompt ? ["--append-system-prompt", input.policy.appendSystemPrompt] : []),
        ...(input.providerSessionId ? ["--resume", input.providerSessionId] : [])
      ]
      const proc = yield* spawnManaged({
        harness: "claude",
        sandboxPrefix: input.policy.sandboxPrefix,
        command: binary,
        args,
        cwd: input.cwd,
        env: { ...input.policy.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }
      })
      const normalizer = new ClaudeNormalizer()
      normalizer.providerSessionId = input.providerSessionId
      const pendingRequests = new Map<string, PendingRequest>()
      const sendControl = (request: Record<string, unknown>) =>
        proc.write(JSON.stringify({ type: "control_request", request_id: randomUUID(), request }) + "\n")
      const sendResponse = (response: Record<string, unknown>) =>
        proc.write(JSON.stringify({ type: "control_response", response }) + "\n")

      const { events } = yield* wireLineProcess({
        harness: "claude",
        process: proc,
        normalizer,
        onMessage: (msg) =>
          Effect.gen(function* () {
            if (isRecord(msg) && msg.type === "control_request" && isRecord(msg.request)) {
              const id = str(msg.request_id)
              if (!id) return true
              if (msg.request.subtype === "can_use_tool") {
                pendingRequests.set(id, {
                  toolName: str(msg.request.tool_name),
                  input: msg.request.input,
                  suggestions: Array.isArray(msg.request.permission_suggestions) ? msg.request.permission_suggestions : []
                })
                return false
              }
              // Anything else (hook callbacks, SDK MCP calls) is not ours to serve: answer at once so Claude never waits.
              yield* sendResponse({ subtype: "error", request_id: id, error: `AgentDesk does not handle ${str(msg.request.subtype) ?? "this request"}` }).pipe(
                Effect.ignore
              )
              return true
            }
            return isRecord(msg) && msg.type === "control_response"
          })
      })

      yield* sendControl({ subtype: "initialize" })
      if (input.prompt) yield* proc.write(userMessage(input.prompt, input.images))

      return {
        harness: "claude",
        pid: proc.pid,
        providerSessionId: Effect.sync(() => normalizer.providerSessionId),
        events: eventsStream(events),
        prompt: (text, images, options) =>
          (options?.model ? sendControl({ subtype: "set_model", model: options.model }) : Effect.void).pipe(
            Effect.andThen(proc.write(userMessage(text, images)))
          ),
        respondToApproval: (requestId, response) => {
          const pending = pendingRequests.get(requestId)
          pendingRequests.delete(requestId)
          return sendResponse({ subtype: "success", request_id: requestId, response: claudeApprovalResponse(pending, response) })
        },
        interrupt: Effect.sync(() => {
          normalizer.interruptRequested = true
        }).pipe(Effect.andThen(sendControl({ subtype: "interrupt" }))),
        // `--effort` is a launch flag: a new effort means resuming in a new process.
        liveEffort: false
      } satisfies HarnessSession
    })

  return {
    id: "claude",
    displayName: "Claude Code",
    capabilities: CLAUDE_CAPABILITIES,
    detect: Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) return { id: "claude" as const, installed: false, detail: "claude CLI not found on PATH" }
      const r = yield* runCommand(binary, ["--version"], { timeoutMs: 10_000 })
      // Ask the CLI which models this account has; older CLIs (or a failure) fall back to the aliases.
      const probe = r.code === 0
        ? yield* runCommand(binary, CLAUDE_MODEL_PROBE_ARGS, {
            timeoutMs: 15_000,
            input: CLAUDE_MODEL_PROBE_INPUT,
            cwd: tmpdir(),
            env: { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }
          })
        : undefined
      const listed = probe ? parseClaudeModels(probe.stdout) : undefined
      return {
        id: "claude" as const,
        installed: r.code === 0,
        binary,
        version: r.stdout.trim().split(/\s+/)[0],
        detail: r.code === 0 ? "Uses the CLI's own login; AgentDesk never reads its credentials." : r.stderr.trim(),
        ...(listed
          ? { models: listed.models, ...(listed.defaultModel && { defaultModel: listed.defaultModel }) }
          : { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS }),
        capabilities: CLAUDE_CAPABILITIES
      }
    }),
    start: (input) => launch(input),
    resume: (input: ResumeInput) => launch(input)
  }
}
