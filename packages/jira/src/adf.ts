/**
 * Converts Atlassian Document Format (Jira Cloud rich text) to plain
 * Markdown-ish text. Output is rendered as text, never as HTML.
 */
type Node = { type?: string; text?: string; content?: Array<Node>; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }

export const adfToText = (doc: unknown): string => {
  if (doc === null || doc === undefined) return ""
  if (typeof doc === "string") return doc
  return render(doc as Node, { listDepth: 0, ordered: false, index: 0 }).replace(/\n{3,}/g, "\n\n").trim()
}

interface Ctx {
  listDepth: number
  ordered: boolean
  index: number
}

const children = (n: Node, ctx: Ctx) => (n.content ?? []).map((c) => render(c, ctx)).join("")

const render = (n: Node, ctx: Ctx): string => {
  switch (n.type) {
    case "doc":
      return children(n, ctx)
    case "paragraph":
      return children(n, ctx) + "\n\n"
    case "text": {
      let t = n.text ?? ""
      for (const m of n.marks ?? []) {
        if (m.type === "code") t = "`" + t + "`"
        if (m.type === "link" && typeof m.attrs?.href === "string") t = `${t} (${m.attrs.href})`
      }
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
        (n.content ?? [])
          .map((item, i) => render(item, { listDepth: ctx.listDepth + 1, ordered, index: i + 1 }))
          .join("") + (ctx.listDepth === 0 ? "\n" : "")
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
      return "```" + String(n.attrs?.language ?? "") + "\n" + children(n, ctx) + "\n```\n\n"
    case "blockquote":
      return children(n, ctx)
        .split("\n")
        .map((l) => (l ? "> " + l : l))
        .join("\n")
    case "rule":
      return "---\n\n"
    case "mention":
      return "@" + String(n.attrs?.text ?? n.attrs?.id ?? "user").replace(/^@/, "")
    case "emoji":
      return String(n.attrs?.text ?? n.attrs?.shortName ?? "")
    case "inlineCard":
    case "blockCard":
      return String(n.attrs?.url ?? "")
    case "table":
      return (n.content ?? []).map((row) => render(row, ctx)).join("") + "\n"
    case "tableRow":
      return "| " + (n.content ?? []).map((cell) => render(cell, ctx).replace(/\n+/g, " ").trim()).join(" | ") + " |\n"
    case "tableHeader":
    case "tableCell":
      return children(n, ctx)
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[attachment]\n"
    default:
      return children(n, ctx)
  }
}
