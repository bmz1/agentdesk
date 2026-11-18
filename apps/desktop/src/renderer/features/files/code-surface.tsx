import { useVirtualizer } from "@tanstack/react-virtual"
import type * as React from "react"
import { useMemo, useRef } from "react"
import { languageFor, tokenStyle, tokensFor, useHighlightedLines } from "@/lib/highlight"
import { cn } from "@/lib/utils"

const LINE_H = 19

export interface CodeSurfaceEdit {
  readonly label: string
  readonly onChange: (text: string) => void
  readonly onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

/**
 * The file viewer's code area: virtualized, syntax-highlighted lines with a line-number gutter.
 * With `edit`, a transparent textarea sits exactly over the code (same font, line height and
 * columns), so editing looks like the viewer: highlighting, gutter and scrolling are unchanged
 * and only the caret and selection come from the textarea.
 */
export const CodeSurface = ({
  text,
  path,
  edit,
  children,
  ...rest
}: {
  text: string
  path: string
  edit?: CodeSurfaceEdit
  children?: React.ReactNode
  "data-testid"?: string
}) => {
  const lines = useMemo(() => text.split("\n"), [text])
  const highlighted = useHighlightedLines(text, languageFor(path), { live: !!edit })
  const widest = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines])
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 30
  })
  const gutter = `${String(lines.length).length + 2}ch`

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto bg-bg font-mono text-[12px] leading-[19px] [tab-size:4]"
      data-testid={rest["data-testid"]}
    >
      <div style={{ height: virtual.getTotalSize(), minWidth: `calc(${gutter} + ${widest + 4}ch)` }} className="relative">
        {virtual.getVirtualItems().map((v) => {
          const line = lines[v.index]!
          const tokens = tokensFor(highlighted, v.index, line)
          return (
            <div
              key={v.index}
              className={cn("absolute inset-x-0 top-0 flex", !edit && "hover:bg-bg-muted/60")}
              style={{ height: LINE_H, transform: `translateY(${v.start}px)` }}
            >
              <span className="shrink-0 pr-3 text-right text-fg-subtle select-none" style={{ width: gutter }}>
                {v.index + 1}
              </span>
              <span className="shiki-code pr-4 whitespace-pre text-fg">
                {tokens
                  ? tokens.map((t, i) => (
                      <span key={i} style={tokenStyle(t)}>
                        {t.content}
                      </span>
                    ))
                  : line}
              </span>
            </div>
          )
        })}
        {edit && (
          <textarea
            autoFocus
            aria-label={edit.label}
            value={text}
            onChange={(e) => edit.onChange(e.target.value)}
            onKeyDown={edit.onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            wrap="off"
            style={{ left: gutter }}
            className="absolute top-0 right-0 bottom-0 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre text-transparent caret-fg outline-none selection:bg-accent/30 selection:text-transparent"
            data-testid="file-editor-input"
          />
        )}
      </div>
      {children}
    </div>
  )
}
