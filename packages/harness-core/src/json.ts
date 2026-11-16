/** Parse one JSONL line. Returns undefined for blank/invalid lines instead of throwing. */
export const parseJsonLine = (line: string): unknown => {
  const trimmed = line.trim()
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u)

export const str = (u: unknown): string | undefined => (typeof u === "string" ? u : undefined)
export const num = (u: unknown): number | undefined => (typeof u === "number" ? u : undefined)

/** Summarize a tool input for approval cards / timelines. */
export const summarizeToolInput = (name: string, input: unknown): string => {
  if (isRecord(input)) {
    const cmd = str(input.command) ?? str(input.cmd)
    if (cmd) return `${name}: ${cmd}`
    const path = str(input.file_path) ?? str(input.path) ?? str(input.filePath)
    if (path) return `${name}: ${path}`
    const pattern = str(input.pattern) ?? str(input.url) ?? str(input.query)
    if (pattern) return `${name}: ${pattern}`
  }
  if (Array.isArray(input)) return `${name}: ${input.join(" ")}`
  return name
}
