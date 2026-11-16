import { randomUUID } from "node:crypto"
import type { PermissionMode } from "@agentdesk/contracts"
import {
  eventsStream,
  findExecutable,
  HarnessError,
  type HarnessAdapter,
  type HarnessSession,
  isRecord,
  type ResumeInput,
  runCommand,
  spawnManaged,
  type StartInput,
  str,
  wireLineProcess
} from "@agentdesk/harness-core"
import { Effect } from "effect"
import { ClaudeNormalizer } from "./normalizer"

export interface ClaudeAdapterOptions {
  readonly binary?: string
}

const permissionFlags = (mode: PermissionMode): Array<string> => {
  switch (mode) {
    case "accept_edits":
      return ["--permission-mode", "acceptEdits"]
    case "plan":
      return ["--permission-mode", "plan"]
    case "unrestricted":
      return ["--dangerously-skip-permissions"]
    case "ask":
      return []
  }
}

const userMessage = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n"

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
        ...(input.policy.appendSystemPrompt ? ["--append-system-prompt", input.policy.appendSystemPrompt] : []),
        ...(input.providerSessionId ? ["--resume", input.providerSessionId] : [])
      ]
      const proc = yield* spawnManaged({
        harness: "claude",
        command: binary,
        args,
        cwd: input.cwd,
        env: { ...input.policy.env, CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }
      })
      const normalizer = new ClaudeNormalizer()
      normalizer.providerSessionId = input.providerSessionId
      const pendingToolInputs = new Map<string, unknown>()
      const sendControl = (request: Record<string, unknown>) =>
        proc.write(JSON.stringify({ type: "control_request", request_id: randomUUID(), request }) + "\n")

      const { events } = yield* wireLineProcess({
        harness: "claude",
        process: proc,
        normalizer,
        onMessage: (msg) =>
          Effect.sync(() => {
            if (isRecord(msg) && msg.type === "control_request" && isRecord(msg.request)) {
              const id = str(msg.request_id)
              if (id) pendingToolInputs.set(id, msg.request.input)
            }
            return isRecord(msg) && msg.type === "control_response"
          })
      })

      yield* sendControl({ subtype: "initialize" })
      if (input.prompt) yield* proc.write(userMessage(input.prompt))

      return {
        harness: "claude",
        pid: proc.pid,
        providerSessionId: Effect.sync(() => normalizer.providerSessionId),
        events: eventsStream(events),
        prompt: (text) => proc.write(userMessage(text)),
        respondToApproval: (requestId, decision, note) => {
          const input = pendingToolInputs.get(requestId)
          pendingToolInputs.delete(requestId)
          const response =
            decision === "allow"
              ? { behavior: "allow", updatedInput: input ?? {} }
              : { behavior: "deny", message: note ?? "Denied by the user in AgentDesk" }
          return proc.write(
            JSON.stringify({
              type: "control_response",
              response: { subtype: "success", request_id: requestId, response }
            }) + "\n"
          )
        },
        interrupt: sendControl({ subtype: "interrupt" })
      } satisfies HarnessSession
    })

  return {
    id: "claude",
    displayName: "Claude Code",
    detect: Effect.gen(function* () {
      const binary = resolveBinary()
      if (!binary) return { id: "claude" as const, installed: false, detail: "claude CLI not found on PATH" }
      const r = yield* runCommand(binary, ["--version"], { timeoutMs: 10_000 })
      return {
        id: "claude" as const,
        installed: r.code === 0,
        binary,
        version: r.stdout.trim().split(/\s+/)[0],
        detail: r.code === 0 ? "Uses the CLI's own login; AgentDesk never reads its credentials." : r.stderr.trim()
      }
    }),
    start: (input) => launch(input),
    resume: (input: ResumeInput) => launch(input)
  }
}
