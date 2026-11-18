import { Markdown, type MarkdownComponents } from "@tanstack/markdown/react"
import { isValidElement, type ReactNode } from "react"
import { openExternal } from "@/lib/connection"
import { languageFor } from "@/lib/highlight"
import { cn } from "@/lib/utils"
import { Code } from "../session/markdown"

/**
 * Renders an issue description synced from a task source (Jira, Linear) as Markdown.
 * The text is untrusted: raw HTML stays text (TanStack Markdown's default, `allowHtml` is
 * never set), executable URLs are dropped by the parser, links open in the system browser,
 * and images are shown as links so viewing a ticket never fetches remote content.
 */
export const IssueMarkdown = ({ text, className }: { text: string; className?: string }) => (
  <div className={cn("prose-chat break-words", className)} data-testid="issue-markdown">
    <Markdown components={components}>{text}</Markdown>
  </div>
)

const isWebUrl = (href: string | undefined): href is string => !!href && /^https?:\/\//i.test(href)

const ExternalLink = ({ href, children }: { href?: string; children?: ReactNode }) => (
  <a
    href={href}
    title={href}
    onClick={(e) => {
      e.preventDefault()
      if (isWebUrl(href)) void openExternal(href)
    }}
  >
    {children}
  </a>
)

// Fenced code arrives as <pre><code class="language-x">text</code></pre>.
const CodeBlock = ({ children }: { children?: ReactNode }) => {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : undefined
  const text = typeof code?.children === "string" ? code.children : ""
  const language = /language-([^\s]+)/.exec(code?.className ?? "")?.[1]
  const lang = language && language !== "plaintext" ? language : undefined
  return <Code code={text.replace(/\n$/, "")} title={lang ?? "text"} lang={lang ? languageFor(lang) : undefined} />
}

const components: MarkdownComponents = {
  a: ExternalLink,
  pre: CodeBlock,
  img: ({ src, alt }) => <ExternalLink href={typeof src === "string" ? src : undefined}>{alt || "image"}</ExternalLink>
}
