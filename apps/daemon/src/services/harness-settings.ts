import { HarnessSettings as SettingsSchema, type HarnessId, type UpdateHarnessSettingsBody } from "@agentdesk/contracts"
import { settings } from "@agentdesk/db"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { DaemonConfig } from "../config"
import { BadRequest, type DbError } from "../errors"
import { Database } from "./database"
import { Notices } from "./notices"

type Settings = typeof SettingsSchema.Type
const key = "harness-defaults"
export const initialHarnessSettings = (): Settings => ({
  defaultHarness: "claude",
  harnesses: {
    claude: { model: null, permissionMode: "ask", instructions: "" },
    codex: { model: null, permissionMode: "ask", instructions: "" },
    opencode: { model: null, permissionMode: "ask", instructions: "" },
    mock: { model: null, permissionMode: "ask", instructions: "" }
  }
})

export class HarnessSettings extends Context.Service<HarnessSettings, {
  readonly get: Effect.Effect<Settings, DbError>
  readonly update: (body: UpdateHarnessSettingsBody) => Effect.Effect<Settings, DbError | BadRequest>
}>()("agentdesk/HarnessSettings") {
  static readonly layer = Layer.effect(HarnessSettings, Effect.gen(function* () {
    const { use } = yield* Database
    const notices = yield* Notices
    const config = yield* DaemonConfig
    const decode = Schema.decodeUnknownSync(SettingsSchema)
    const get = use((db) => {
      const stored = db.select().from(settings).where(eq(settings.key, key)).get()
      return stored ? decode(stored.value) : initialHarnessSettings()
    })
    const update = Effect.fn("HarnessSettings.update")(function* (body: UpdateHarnessSettingsBody) {
      const updates = body.harnesses ?? {}
      for (const [id, profile] of Object.entries(updates)) {
        if (!profile) continue
        if (profile.permissionMode === "unrestricted" && !config.sandboxPrefix?.length) {
          return yield* new BadRequest({ message: "Unrestricted permissions require AGENTDESK_SANDBOX_CMD. Configure a sandbox or choose another permission mode." })
        }
        if (id === "opencode" && profile.model?.trim() && !/^[^/\s]+\/.+/.test(profile.model.trim())) {
          return yield* new BadRequest({ message: "OpenCode models must use provider/model, for example provider/model-name." })
        }
      }
      // Merge and write in one SQLite callback so separate profile saves cannot clobber each other.
      const result = yield* use((db) => {
        const row = db.select().from(settings).where(eq(settings.key, key)).get()
        const current = row ? decode(row.value) : initialHarnessSettings()
        const harnesses = { ...current.harnesses }
        for (const id of Object.keys(updates) as Array<HarnessId>) {
          const value = updates[id]
          if (value) harnesses[id] = { ...value, model: value.model?.trim() || null, instructions: value.instructions.trim() }
        }
        const next: Settings = { defaultHarness: body.defaultHarness ?? current.defaultHarness, harnesses }
        db.insert(settings).values({ key, value: next }).onConflictDoUpdate({ target: settings.key, set: { value: next } }).run()
        return next
      })
      yield* notices.publish({ topic: "settings" })
      return result
    })
    return HarnessSettings.of({ get, update })
  }))
}
