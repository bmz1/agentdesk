import type { HarnessDetection, HarnessId } from "@agentdesk/contracts"
import { makeClaudeAdapter } from "@agentdesk/harness-claude"
import { makeCodexAdapter } from "@agentdesk/harness-codex"
import { type HarnessAdapter, type HarnessError, makeMockAdapter, makeRegistry } from "@agentdesk/harness-core"
import { makeOpenCodeAdapter } from "@agentdesk/harness-opencode"
import { Cache, Context, Duration, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"

export interface HarnessesShape {
  readonly list: ReadonlyArray<HarnessAdapter>
  readonly get: (id: HarnessId) => Effect.Effect<HarnessAdapter, HarnessError>
  /** Detected harness CLIs, cached for 5 minutes (version probes spawn processes). */
  readonly detect: (refresh?: boolean) => Effect.Effect<ReadonlyArray<HarnessDetection>>
}

export class Harnesses extends Context.Service<Harnesses, HarnessesShape>()("agentdesk/Harnesses") {}

export const defaultAdapters = (): ReadonlyArray<HarnessAdapter> => [
  makeClaudeAdapter(),
  makeCodexAdapter(),
  makeOpenCodeAdapter(),
  makeMockAdapter()
]

export const HarnessesLive = (adapters: ReadonlyArray<HarnessAdapter> = defaultAdapters()) =>
  Layer.effect(
    Harnesses,
    Effect.gen(function* () {
      const registry = makeRegistry(adapters)
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const cache = yield* Cache.make({
        capacity: 1,
        timeToLive: Duration.minutes(5),
        lookup: (_: "all") =>
          registry.detectAll.pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.withSpan("Harnesses.detectAll")
          )
      })
      return Harnesses.of({
        list: registry.list,
        get: registry.get,
        detect: Effect.fn("Harnesses.detect")(function* (refresh = false) {
          if (refresh) yield* Cache.invalidate(cache, "all")
          return yield* Cache.get(cache, "all")
        })
      })
    })
  )
