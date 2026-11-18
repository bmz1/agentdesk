import type { HarnessDetection, HarnessId } from "@agentdesk/contracts"
import { Effect } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { HarnessError } from "./errors"
import type { HarnessAdapter } from "./types"

export interface HarnessRegistryShape {
  readonly list: ReadonlyArray<HarnessAdapter>
  readonly get: (id: HarnessId) => Effect.Effect<HarnessAdapter, HarnessError>
  readonly detectAll: Effect.Effect<ReadonlyArray<HarnessDetection>, never, ChildProcessSpawner.ChildProcessSpawner>
}

export const makeRegistry = (adapters: ReadonlyArray<HarnessAdapter>): HarnessRegistryShape => {
  const byId = new Map(adapters.map((a) => [a.id, a] as const))
  return {
    list: adapters,
    get: (id) => {
      const a = byId.get(id)
      return a
        ? Effect.succeed(a)
        : Effect.fail(new HarnessError({ harness: id, reason: "unsupported", message: `Harness ${id} is not registered` }))
    },
    // Every detection says what its harness supports, so the UI only offers settings that take effect.
    detectAll: Effect.forEach(adapters, (a) => a.detect.pipe(Effect.map((d) => ({ ...d, capabilities: d.capabilities ?? a.capabilities }))), {
      concurrency: "unbounded"
    })
  }
}
