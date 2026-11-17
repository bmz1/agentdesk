/**
 * Best-effort secret redaction for agent events, logs and diff previews.
 * Patterns target well-known credential formats; it is a safety net, not a
 * guarantee, so secrets must still be kept out of agent environments.
 */
const PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,})\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED GITLAB TOKEN]"],
  [/\bATATT[A-Za-z0-9_\-=]{40,}\b/g, "[REDACTED ATLASSIAN TOKEN]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED SLACK TOKEN]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/g, "[REDACTED API KEY]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED GOOGLE KEY]"],
  [/(\bAuthorization:\s*(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]"],
  [
    /((?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    "$1[REDACTED]"
  ]
]

export const redactSecrets = (text: string): string => {
  let out = text
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement)
  return out
}

/** Recursively redact all strings in a JSON-like value. */
export const redactDeep = <T>(value: T): T => {
  if (typeof value === "string") return redactSecrets(value) as T
  if (Array.isArray(value)) return value.map(redactDeep) as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v)
    return out as T
  }
  return value
}
