/**
 * Real-CLI permission matrix. Opt-in: AGENTDESK_SMOKE=claude,codex,opencode pnpm test:permissions
 * For each permission mode, the agent creates a file, edits a file, runs a read-only command and a
 * writing command. Every approval is allowed; the test records which kinds asked and what changed.
 * Needs each harness installed and logged in. Models choose their own tools, so the checks are about
 * kinds of requests (edit, shell), not exact tool names.
 */
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, HarnessId, PermissionMode } from "@agentdesk/contracts"
import { NodeProcessLayer } from "@agentdesk/harness-core"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { defaultAdapters } from "../src/services/harnesses"

const enabled = (process.env.AGENTDESK_SMOKE ?? "").split(",").filter(Boolean) as Array<HarnessId>

const TASK =
  "Do exactly these, in order, with your tools and without asking me anything: " +
  "1) create notes.txt containing x; 2) change the word hi in existing.txt to bye; " +
  "3) run the shell command `ls`; 4) run the shell command `touch made-by-shell.txt`. Then reply done."

const kind = (toolName: string) => {
  const t = toolName.toLowerCase()
  if (["write", "edit", "multiedit", "apply_patch", "patch"].includes(t)) return "edit"
  if (["bash", "shell"].includes(t)) return "shell"
  return t
}

const run = (id: HarnessId, mode: PermissionMode) => {
  const repo = mkdtempSync(join(tmpdir(), `perm-${id}-${mode}-`))
  execSync("git init -q -b main", { cwd: repo })
  writeFileSync(join(repo, "existing.txt"), "hi\n")
  const adapter = defaultAdapters().find((a) => a.id === id)!
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* adapter.start({ cwd: repo, policy: { permissionMode: mode }, prompt: TASK })
        const asked: Array<string> = []
        yield* s.events.pipe(
          Stream.tap((e: AgentEvent) =>
            e.type === "approval.requested"
              ? Effect.sync(() => asked.push(kind(e.toolName))).pipe(
                  // Accepting a plan ends plan mode (Claude); the plan check is about staying in it.
                  Effect.andThen(
                    s.respondToApproval(e.providerRequestId ?? e.approvalId, {
                      decision: /exitplanmode/i.test(e.toolName) ? "deny" : "allow"
                    })
                  )
                )
              : Effect.void
          ),
          Stream.takeUntil((e) => e.type === "turn.completed" || e.type === "session.exited"),
          Stream.runDrain,
          Effect.timeout("240 seconds")
        )
        return {
          asked,
          created: existsSync(join(repo, "notes.txt")),
          edited: readFileSync(join(repo, "existing.txt"), "utf8").includes("bye"),
          shellWrote: existsSync(join(repo, "made-by-shell.txt"))
        }
      })
    ).pipe(Effect.provide(NodeProcessLayer))
  )
}

describe.skipIf(enabled.length === 0)("real harness permission modes", () => {
  for (const id of enabled) {
    it(`${id}: ask asks before every change, but not before reading`, async () => {
      const r = await run(id, "ask")
      console.log(`[perm:${id}:ask]`, r)
      // Creating, editing and the writing command each ask, whether done with edit tools or the shell.
      expect(r.asked.filter((k) => k === "edit" || k === "shell").length).toBeGreaterThanOrEqual(3)
      expect(r.asked).not.toContain("read")
    }, 300_000)

    it(`${id}: accept_edits edits freely but asks before writing commands`, async () => {
      const r = await run(id, "accept_edits")
      console.log(`[perm:${id}:accept_edits]`, r)
      expect(r.asked).not.toContain("edit")
      expect(r.asked).toContain("shell")
      expect(r.created && r.edited).toBe(true)
    }, 300_000)

    it(`${id}: auto lets routine work through without the user`, async () => {
      const r = await run(id, "auto")
      console.log(`[perm:${id}:auto]`, r)
      expect(r.asked).not.toContain("edit")
      expect(r.created && r.edited).toBe(true)
    }, 300_000)

    it(`${id}: plan changes no files`, async () => {
      const r = await run(id, "plan")
      console.log(`[perm:${id}:plan]`, r)
      expect(r.created || r.edited).toBe(false)
    }, 300_000)
  }
})
