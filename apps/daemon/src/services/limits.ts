import type { AgentEvent, HarnessId, HarnessRateLimits } from "@agentdesk/contracts"
import { Context, Effect, Layer } from "effect"
import { nowIso } from "../util"
import { Notices } from "./notices"

/**
 * The latest subscription rate limits each harness reported (Claude's 5-hour and weekly
 * windows, Codex's primary and secondary). Harnesses report them with their turns; the
 * daemon keeps only the newest per harness and pushes changes to clients.
 */
export interface LimitsShape {
  readonly update: (harness: HarnessId, event: Extract<AgentEvent, { type: "rate_limit" }>) => Effect.Effect<void>
  readonly list: Effect.Effect<ReadonlyArray<HarnessRateLimits>>
}

export class Limits extends Context.Service<Limits, LimitsShape>()("agentdesk/Limits") {
  static readonly layer = Layer.effect(
    Limits,
    Effect.gen(function* () {
      const notices = yield* Notices
      const latest = new Map<HarnessId, HarnessRateLimits>()
      return Limits.of({
        update: (harness, event) =>
          Effect.gen(function* () {
            const limits: HarnessRateLimits = { harness, windows: event.windows, limited: event.limited ?? false, updatedAt: yield* nowIso }
            latest.set(harness, limits)
            yield* notices.publish({ topic: "limits", limits })
          }),
        list: Effect.sync(() => [...latest.values()])
      })
    })
  )
}
