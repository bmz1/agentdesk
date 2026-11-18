import type { AgentQuestion, HarnessModel, PermissionMode, QuestionAnswers } from "@agentdesk/contracts"
import { isRecord, str } from "@agentdesk/harness-core"

/** One OpenCode v2 permission rule. The last rule matching an action and resource decides. */
export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

const rule = (action: string, effect: PermissionRule["effect"], resource = "*"): PermissionRule => ({ action, resource, effect })

/** Looking around, never changing anything, and asking the user something: never worth an approval card. */
const READ_ONLY = ["read", "grep", "glob", "question", "skill"].map((a) => rule(a, "allow"))
/** OpenCode's own defaults keep env files behind a prompt even when reads are allowed; so do we. */
const SECRETS = [rule("read", "ask", "*.env"), rule("read", "ask", "*.env.*"), rule("read", "allow", "*.env.example")]

/**
 * AgentDesk's permission modes as an OpenCode v2 session ruleset. Session rules come after the agent's
 * own, and the last match wins, so these decide. Anything not named (shell, web, MCP tools, subagents,
 * files outside the worktree) asks. A rule that denies an action outright also hides its tools.
 */
export const openCodePermissions = (mode: PermissionMode): ReadonlyArray<PermissionRule> => {
  switch (mode) {
    case "ask":
      return [rule("*", "ask"), ...READ_ONLY, ...SECRETS]
    case "accept_edits":
      return [rule("*", "ask"), ...READ_ONLY, rule("edit", "allow"), ...SECRETS]
    // OpenCode has no approval classifier: auto also lets edits, web lookups and subagents run; shell still asks.
    case "auto":
      return [rule("*", "ask"), ...READ_ONLY, ...["edit", "webfetch", "websearch", "subagent"].map((a) => rule(a, "allow")), ...SECRETS]
    // No plan agent in OpenCode 2, and no way to tell a read-only command from one that writes: plan denies
    // edits and shell commands (which also hides their tools). Reading, searching and the web still work.
    case "plan":
      return [rule("*", "ask"), ...READ_ONLY, rule("edit", "deny"), rule("shell", "deny"), ...SECRETS]
    case "unrestricted":
      return [rule("*", "allow")]
  }
}

/** `provider/model[@variant]` ids AgentDesk stores ↔ OpenCode's model reference. Model ids may contain "/". */
export const openCodeModel = (model: string | undefined, variant?: string) => {
  const i = model?.indexOf("/") ?? -1
  return model && i > 0 ? { providerID: model.slice(0, i), id: model.slice(i + 1), ...(variant && { variant }) } : undefined
}

/** `GET /api/model` entries → models AgentDesk offers; each model's variants are its effort levels. */
export const parseModels = (data: unknown): Array<HarnessModel> =>
  (Array.isArray(data) ? data.filter(isRecord) : []).flatMap((m) => {
    const id = str(m.id)
    const provider = str(m.providerID)
    if (!id || !provider || m.enabled === false || m.status === "deprecated") return []
    const efforts = (Array.isArray(m.variants) ? m.variants.filter(isRecord) : []).flatMap((v) => str(v.id) ?? [])
    return [{ id: `${provider}/${id}`, label: str(m.name) ?? id, provider, ...(efforts.length && { efforts }) }]
  })

/** `opencode models` prints one `provider/model` per line: the fallback when the server can't be asked. */
export const parseModelLines = (stdout: string): Array<HarnessModel> =>
  stdout.split("\n").flatMap((line) => {
    const id = line.trim()
    const m = openCodeModel(id)
    return m && !/\s/.test(id) ? [{ id, label: m.id, provider: m.providerID }] : []
  })

const YES = "Yes"
const NO = "No"

/**
 * An OpenCode form (the agent asking the user something) → canonical questions, one per visible field,
 * answered under the field's key. Booleans become Yes/No choices.
 */
export const formQuestions = (form: unknown): Array<AgentQuestion> => {
  const f = isRecord(form) ? form : {}
  const fields = Array.isArray(f.fields) ? f.fields.filter(isRecord) : []
  return fields.flatMap((field) => {
    const key = str(field.key)
    if (!key || field.hidden === true || field.type === "external") return []
    const question = str(field.description) ?? str(field.title) ?? str(f.title) ?? key
    const header = str(field.title) && str(field.description) ? str(field.title) : undefined
    const options = (Array.isArray(field.options) ? field.options.filter(isRecord) : []).flatMap((o) =>
      str(o.label) ? [{ label: str(o.label)!, ...(str(o.description) && { description: str(o.description) }) }] : []
    )
    if (field.type === "boolean") {
      return [{ id: key, ...(header && { header }), question, options: [{ label: YES }, { label: NO }], multiSelect: false, allowOther: false }]
    }
    return [
      {
        id: key,
        ...(header && { header }),
        question,
        options,
        multiSelect: field.type === "multiselect",
        // Free text fits string and number fields, and multiselects that accept custom values.
        allowOther: field.type === "multiselect" ? field.custom === true : options.length === 0 || field.type !== "string"
      }
    ]
  })
}

/** The user's answers (option labels or free text, by field key) → an OpenCode form answer. */
export const formAnswer = (form: unknown, answers: QuestionAnswers | undefined): Record<string, string | number | boolean | ReadonlyArray<string>> => {
  const f = isRecord(form) ? form : {}
  const fields = Array.isArray(f.fields) ? f.fields.filter(isRecord) : []
  const out: Record<string, string | number | boolean | ReadonlyArray<string>> = {}
  for (const field of fields) {
    const key = str(field.key)
    const given = key ? answers?.[key] : undefined
    if (!key || !given?.length) continue
    const options = Array.isArray(field.options) ? field.options.filter(isRecord) : []
    // Options are answered by label; OpenCode wants their values.
    const value = (label: string) => str(options.find((o) => o.label === label)?.value) ?? label
    switch (field.type) {
      case "boolean":
        out[key] = given[0] === YES
        break
      case "number":
      case "integer": {
        const n = Number(given[0])
        if (Number.isFinite(n)) out[key] = field.type === "integer" ? Math.trunc(n) : n
        break
      }
      case "multiselect":
        out[key] = given.map(value)
        break
      default:
        out[key] = value(given[0]!)
    }
  }
  return out
}
