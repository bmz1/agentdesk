import { Effect, Schema } from "effect"
import { type SourceDescriptor, type TaskSourceAdapter, TaskSourceError } from "./types"

export interface SourceRegistry {
  readonly list: ReadonlyArray<TaskSourceAdapter<any>>
  readonly descriptors: ReadonlyArray<SourceDescriptor>
  readonly get: (id: string) => Effect.Effect<TaskSourceAdapter<any>, TaskSourceError>
  /** Decode raw settings with the adapter's schema (SchemaError on invalid input). */
  readonly decodeSettings: (id: string, raw: unknown) => Effect.Effect<unknown, TaskSourceError | Schema.SchemaError>
}

export const describe = (a: TaskSourceAdapter<any>): SourceDescriptor => ({
  id: a.id,
  displayName: a.displayName,
  description: a.description,
  fields: a.fields,
  credential: a.credential,
  scopeLabel: a.scopeLabel ?? "Project"
})

export const makeSourceRegistry = (adapters: ReadonlyArray<TaskSourceAdapter<any>>): SourceRegistry => {
  const byId = new Map(adapters.map((a) => [a.id, a] as const))
  if (byId.has("local")) throw new Error(`"local" is reserved for local tickets`)
  const get = (id: string): Effect.Effect<TaskSourceAdapter<any>, TaskSourceError> => {
    const a = byId.get(id)
    return a
      ? Effect.succeed(a)
      : Effect.fail(new TaskSourceError({ source: id, kind: "config", message: `Unknown task source "${id}"` }))
  }
  return {
    list: adapters,
    descriptors: adapters.map(describe),
    get,
    decodeSettings: (id, raw) =>
      get(id).pipe(
        Effect.flatMap((a) => Schema.decodeUnknownEffect(a.settings)(raw) as Effect.Effect<unknown, Schema.SchemaError>)
      )
  }
}
