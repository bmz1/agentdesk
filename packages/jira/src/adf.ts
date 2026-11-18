/**
 * Converts Atlassian Document Format (Jira Cloud rich text) to Markdown, so the
 * desktop renders it like the issue looks in Jira and agents read familiar syntax.
 * The renderer never allows raw HTML, so markup in issue text stays inert.
 */
type Node = {
  type?: string
  text?: string
  content?: Array<Node>
  attrs?: Record<string, unknown>
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

export const adfToText = (doc: unknown): string => {
  if (doc === null || doc === undefined) return ""
  if (typeof doc === "string") return doc
  return render(doc as Node, { listDepth: 0, ordered: false, index: 0 })
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

interface Ctx {
  listDepth: number
  ordered: boolean
  index: number
  /** Inside a code block: text is emitted verbatim. */
  code?: boolean
}

/**
 * Escapes characters that would otherwise turn issue text into formatting (a_b_c, *ptr,
 * [x]) and block markers at the start of a line. `<` is left alone: raw HTML renders as text.
 */
export const escapeMarkdown = (t: string) =>
  t
    .replace(/[\\`*_[\]~|]/g, "\\$&")
    .replace(/^(\s*)(\d+)([.)])(?=\s)/gm, "$1$2\\$3")
    .replace(/^(\s*)([#>+-])/gm, "$1\\$2")

/** Percent-encodes what would end a Markdown link destination early. */
const linkTarget = (href: string) => href.replace(/[()\s<>]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))

const wrap = (t: string, marker: string) => {
  // Emphasis markers must hug the text: move surrounding spaces outside them.
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(t)!
  return m[2] ? `${m[1]}${marker}${m[2]}${marker}${m[3]}` : t
}

const children = (n: Node, ctx: Ctx) => (n.content ?? []).map((c) => render(c, ctx)).join("")

const render = (n: Node, ctx: Ctx): string => {
  switch (n.type) {
    case "doc":
      return children(n, ctx)
    case "paragraph":
      return children(n, ctx) + "\n\n"
    case "text": {
      const raw = n.text ?? ""
      if (ctx.code) return raw
      const marks = new Map((n.marks ?? []).map((m) => [m.type, m] as const))
      let t: string
      if (marks.has("code")) {
        const fence = raw.includes("`") ? "``" : "`"
        t = `${fence}${raw.includes("`") ? ` ${raw} ` : raw}${fence}`
      } else t = escapeMarkdown(raw)
      if (marks.has("strong")) t = wrap(t, "**")
      if (marks.has("em")) t = wrap(t, "*")
      if (marks.has("strike")) t = wrap(t, "~~")
      const href = marks.get("link")?.attrs?.href
      if (typeof href === "string") t = `[${t}](${linkTarget(href)})`
      return t
    }
    case "hardBreak":
      return "\n"
    case "heading":
      return "#".repeat(Number(n.attrs?.level ?? 1)) + " " + children(n, ctx) + "\n\n"
    case "bulletList":
    case "orderedList": {
      const ordered = n.type === "orderedList"
      return (
        (n.content ?? []).map((item, i) => render(item, { listDepth: ctx.listDepth + 1, ordered, index: i + 1 })).join("") +
        (ctx.listDepth === 0 ? "\n" : "")
      )
    }
    case "listItem": {
      const indent = "  ".repeat(Math.max(0, ctx.listDepth - 1))
      const bullet = ctx.ordered ? `${ctx.index}. ` : "- "
      const body = (n.content ?? [])
        .map((c) => render(c, { ...ctx }))
        .join("")
        .replace(/\n\n$/g, "\n")
        .replace(/\n\n/g, "\n")
      return indent + bullet + body.replace(/^\s+/, "")
    }
    case "codeBlock":
      return "```" + String(n.attrs?.language ?? "") + "\n" + children(n, { ...ctx, code: true }) + "\n```\n\n"
    case "blockquote":
      return children(n, ctx)
        .split("\n")
        .map((l) => (l ? "> " + l : l))
        .join("\n")
    case "rule":
      return "---\n\n"
    case "mention":
      return "@" + escapeMarkdown(String(n.attrs?.text ?? n.attrs?.id ?? "user").replace(/^@/, ""))
    case "emoji":
      return String(n.attrs?.text ?? n.attrs?.shortName ?? "")
    case "inlineCard":
    case "blockCard": {
      const url = String(n.attrs?.url ?? "")
      return url ? `[${escapeMarkdown(url)}](${linkTarget(url)})` + (n.type === "blockCard" ? "\n\n" : "") : ""
    }
    case "table": {
      // Markdown tables need a header row; Jira tables may have none, so the first row serves.
      const rows = (n.content ?? []).map((row) => render(row, ctx))
      if (rows.length === 0) return ""
      const cols = (n.content?.[0]?.content ?? []).length || 1
      return "\n" + [rows[0], "|" + " --- |".repeat(cols) + "\n", ...rows.slice(1)].join("") + "\n"
    }
    case "tableRow":
      return "| " + (n.content ?? []).map((cell) => render(cell, ctx).replace(/\n+/g, " ").trim()).join(" | ") + " |\n"
    case "tableHeader":
    case "tableCell":
      return children(n, ctx)
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "_(attachment)_\n\n"
    default:
      return children(n, ctx)
  }
}
