import { Fragment } from "react"

/**
 * Minimal, safe text renderer for agent/issue text: fenced code blocks and
 * inline code. Never uses innerHTML — untrusted Jira and agent text stays text.
 */
export const RichText = ({ text }: { text: string }) => {
  const parts = text.split(/```(?:[\w+-]*)\n?/)
  return (
    <div className="prose-agent whitespace-pre-wrap break-words leading-relaxed">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i}>{part.replace(/\n$/, "")}</pre>
        ) : (
          <Fragment key={i}>{renderInline(part)}</Fragment>
        )
      )}
    </div>
  )
}

const renderInline = (text: string) =>
  text.split(/(`[^`\n]+`)/).map((seg, i) =>
    seg.startsWith("`") && seg.endsWith("`") && seg.length > 2 ? <code key={i}>{seg.slice(1, -1)}</code> : <Fragment key={i}>{seg}</Fragment>
  )
