import type * as React from "react"
import ReactMarkdown, { type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle
} from "@/components/ui/code-block"
import { openExternal } from "@/lib/connection"
import { cn } from "@/lib/utils"

/**
 * Agent markdown. react-markdown never renders raw HTML, so untrusted agent output
 * stays text; links open in the system browser instead of navigating the app window.
 */
export const Markdown = ({ text, className }: { text: string; className?: string }) => (
  <div className={cn("prose-chat", className)}>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: MarkdownPre,
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault()
              if (href && /^https?:\/\//.test(href)) void openExternal(href)
            }}
          >
            {children}
          </a>
        )
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
)

// Fenced code arrives as <pre><code>; read it from the hast node.
const MarkdownPre = ({ node, children, ...props }: React.ComponentProps<"pre"> & ExtraProps) => {
  const element = node?.children[0]
  if (element?.type !== "element" || element.tagName !== "code") return <pre {...props}>{children}</pre>
  const language = /language-([^\s,]+)/.exec(String(element.properties.className ?? ""))?.[1] ?? ""
  const code = element.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    .replace(/\n$/, "")
  return <Code code={code} title={language || "text"} />
}

export const Code = ({ code, title, tone }: { code: string; title?: string; tone?: "default" | "destructive" }) => (
  <CodeBlock size="sm" variant={tone} className="my-2">
    {title && (
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
    )}
    <CodeBlockContent className="max-h-80 text-[12px]">{code}</CodeBlockContent>
  </CodeBlock>
)
