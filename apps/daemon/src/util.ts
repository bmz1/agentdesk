import { randomUUID } from "node:crypto"

export const newId = () => randomUUID()
export const nowIso = () => new Date().toISOString()
export const shortId = (id: string) => id.replace(/-/g, "").slice(0, 8)
