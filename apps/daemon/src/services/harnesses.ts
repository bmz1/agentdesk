import type { HarnessDetection } from "@agentdesk/contracts"
import { makeClaudeAdapter } from "@agentdesk/harness-claude"
import { type HarnessAdapter, type HarnessRegistryShape, makeMockAdapter, makeRegistry } from "@agentdesk/harness-core"
import { Context, Duration, Effect, Layer } from "effect"

export interface HarnessesShape extends HarnessRegistryShape {
  /** Cached detection (CLI version probes are slow-ish). */
  readonly detect: (refresh?: boolean) => Effect.Effect<ReadonlyArray<HarnessDetection>>
}

export class Harnesses extends Context.Service<Harnesses, HarnessesShape>()("agentdesk/Harnesses") {}

export const defaultAdapters = (): ReadonlyArray<HarnessAdapter> => [makeClaudeAdapter(), makeMockAdapter()]

export const HarnessesLive = (adapters: ReadonlyArray<HarnessAdapter> = defaultAdapters()) =>
  Layer.effect(
    Harnesses,
    Effect.gen(function* () {
      const registry = makeRegistry(adapters)
      let cached: { at: number; value: ReadonlyArray<HarnessDetection> } | undefined
      const ttl = Duration.toMillis(Duration.minutes(5))
      return {
        ...registry,
        detect: (refresh = false) =>
          Effect.gen(function* () {
            if (!refresh && cached && Date.now() - cached.at < ttl) return cached.value
            const value = yield* registry.detectAll
            cached = { at: Date.now(), value }
            return value
          })
      } satisfies HarnessesShape
    })
  )
