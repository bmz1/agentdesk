import { randomUUID } from "node:crypto"
import { Clock, Effect } from "effect"

export const newId = () => randomUUID()
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8)

/** Current time as ISO-8601, read from the Effect Clock (TestClock-controllable). */
export const nowIso: Effect.Effect<string> = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))
