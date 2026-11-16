import type { HarnessDetection, HarnessId } from "@agentdesk/contracts"
import { Effect } from "effect"
import { HarnessError } from "./errors"
import type { HarnessAdapter } from "./types"

export interface HarnessRegistryShape {
  readonly list: ReadonlyArray<HarnessAdapter>
  readonly get: (id: HarnessId) => Effect.Effect<HarnessAdapter, HarnessError>
  readonly detectAll: Effect.Effect<ReadonlyArray<HarnessDetection>>
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
    detectAll: Effect.forEach(adapters, (a) => a.detect, { concurrency: "unbounded" })
  }
}
