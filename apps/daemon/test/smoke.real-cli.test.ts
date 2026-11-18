/**
 * Real-CLI smoke tests. Opt-in: AGENTDESK_SMOKE=claude,codex,opencode pnpm test
 * Each harness must be installed and logged in with its own supported login.
 */
import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, HarnessId } from "@agentdesk/contracts"
import { Effect, Stream } from "effect"
import { NodeProcessLayer } from "@agentdesk/harness-core"
import { describe, expect, it } from "@effect/vitest"
import { defaultAdapters } from "../src/services/harnesses"

const enabled = (process.env.AGENTDESK_SMOKE ?? "").split(",").filter(Boolean) as Array<HarnessId>

describe.skipIf(enabled.length === 0)("real harness smoke tests", () => {
  for (const id of enabled) {
    it(`${id}: starts headless, streams a turn and reports a provider session id`, async () => {
      const repo = mkdtempSync(join(tmpdir(), `smoke-${id}-`))
      execSync("git init -q -b main", { cwd: repo })
      writeFileSync(join(repo, "README.md"), "smoke\n")
      const adapter = defaultAdapters().find((a) => a.id === id)!
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const s = yield* adapter.start({
              cwd: repo,
              policy: { permissionMode: "plan" },
              prompt: "Reply with exactly the word OK and do not use any tools."
            })
            const seen: Array<AgentEvent> = []
            yield* s.events.pipe(
              Stream.tap((e) => Effect.sync(() => seen.push(e))),
              Stream.takeUntil((e) => e.type === "turn.completed" || e.type === "session.exited"),
              Stream.runDrain,
              Effect.timeout("120 seconds")
            )
            return { seen, providerSessionId: yield* s.providerSessionId }
          })
        ).pipe(Effect.provide(NodeProcessLayer))
      )
      const types = result.seen.map((e) => e.type)
      console.log(
        `[smoke:${id}]`,
        types.join(" "),
        result.seen.filter((e) => e.type === "session.error")
      )
      expect(result.providerSessionId).toBeTruthy()
      expect(types).toContain("turn.completed")
      expect(result.seen.find((e) => e.type === "turn.completed")).toMatchObject({ status: "success" })
    }, 150_000)
  }
})
