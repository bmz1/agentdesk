import { useVirtualizer } from "@tanstack/react-virtual"
import { Brain, Check, ChevronRight, Hand, Terminal, User, Wrench, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/misc"
import { cn } from "@/lib/utils"
import { RichText } from "./rich-text"
import type { TranscriptItem } from "./transcript-model"

export interface TranscriptProps {
  items: ReadonlyArray<TranscriptItem>
  onDecide?: (approvalId: string, decision: "allow" | "deny") => void
  deciding?: string | null
}

/** Virtualized, auto-following transcript of a structured agent session. */
export const Transcript = ({ items, onDecide, deciding }: TranscriptProps) => {
  const parentRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 12,
    getItemKey: (i) => items[i]!.key
  })

  useEffect(() => {
    if (follow && items.length > 0) virtualizer.scrollToIndex(items.length - 1, { align: "end" })
  }, [items, follow, virtualizer])

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      onScroll={(e) => {
        const el = e.currentTarget
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
      }}
      data-testid="transcript"
    >
      <div className="relative mx-auto w-full max-w-3xl" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => (
          <div
            key={v.key}
            ref={virtualizer.measureElement}
            data-index={v.index}
            className="absolute left-0 top-0 w-full px-4 py-1.5"
            style={{ transform: `translateY(${v.start}px)` }}
          >
            <Item item={items[v.index]!} onDecide={onDecide} deciding={deciding} />
          </div>
        ))}
      </div>
    </div>
  )
}

const Item = ({ item, onDecide, deciding }: { item: TranscriptItem } & Pick<TranscriptProps, "onDecide" | "deciding">) => {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex gap-2.5">
          <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-muted">
            <User className="size-3 text-fg-muted" />
          </div>
          <div className="min-w-0 flex-1 rounded-md border bg-bg-subtle px-3 py-2">
            <RichText text={item.text} />
          </div>
        </div>
      )
    case "assistant":
      return (
        <div className="flex gap-2.5">
          <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/20">
            <span className="text-[10px] font-bold text-accent">AI</span>
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <RichText text={item.text} />
            {item.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
          </div>
        </div>
      )
    case "reasoning":
      return <Collapsible icon={<Brain />} title="Reasoning" tone="muted" body={item.text} />
    case "tool":
      return <ToolCall item={item} />
    case "approval":
      return <ApprovalCard item={item} onDecide={onDecide} deciding={deciding === item.approvalId} />
    case "status":
      return (
        <div
          className={cn(
            "pl-7 text-[11px]",
            item.tone === "danger" ? "text-danger" : item.tone === "warning" ? "text-warning" : "text-fg-subtle"
          )}
        >
          {item.text}
        </div>
      )
    case "turn":
      return (
        <div className="flex items-center gap-2 pl-7 text-[11px] text-fg-subtle">
          <div className="h-px flex-1 bg-border" />
          <span>
            Turn {item.status}
            {item.durationMs !== undefined ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}
            {item.costUsd ? ` · $${item.costUsd.toFixed(3)}` : ""}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )
  }
}

const stringify = (u: unknown) => (typeof u === "string" ? u : JSON.stringify(u, null, 2))

const toolSummary = (name: string, input: unknown) => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>
    const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
    if (typeof v === "string") return v
    if (Array.isArray(v)) return v.join(" ")
  }
  return name
}

const ToolCall = ({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) => {
  const [open, setOpen] = useState(false)
  const isShell = /bash|shell|command|exec/i.test(item.name)
  return (
    <div className="ml-7 rounded-md border bg-bg-subtle">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        {isShell ? <Terminal className="size-3.5 shrink-0 text-fg-muted" /> : <Wrench className="size-3.5 shrink-0 text-fg-muted" />}
        <span className="text-xs font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted">{toolSummary(item.name, item.input)}</span>
        {!item.done ? (
          <Spinner className="text-fg-subtle" />
        ) : item.isError ? (
          <X className="size-3.5 text-danger" />
        ) : (
          <Check className="size-3.5 text-success" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t px-2.5 py-2">
          {item.input !== undefined && (
            <pre className="max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg-muted">{stringify(item.input)}</pre>
          )}
          {item.result !== undefined && (
            <pre className={cn("max-h-80 overflow-auto rounded bg-bg p-2 font-mono text-[11px]", item.isError ? "text-danger" : "text-fg")}>
              {stringify(item.result) || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

const Collapsible = ({ icon, title, body, tone }: { icon: React.ReactNode; title: string; body: string; tone: "muted" }) => {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn("ml-7 text-xs", tone === "muted" && "text-fg-subtle")}>
      <button className="flex items-center gap-1.5 [&_svg]:size-3" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("transition-transform", open && "rotate-90")} />
        {icon}
        {title}
      </button>
      {open && <div className="mt-1 whitespace-pre-wrap border-l pl-3 italic">{body}</div>}
    </div>
  )
}

export const ApprovalCard = ({
  item,
  onDecide,
  deciding
}: {
  item: Extract<TranscriptItem, { kind: "approval" }>
  onDecide?: (id: string, d: "allow" | "deny") => void
  deciding?: boolean
}) => {
  const details = item.details as { input?: unknown } | undefined
  return (
    <div
      className={cn(
        "ml-7 rounded-md border px-3 py-2.5",
        item.decision ? "bg-bg-subtle" : "border-warning/50 bg-warning/5"
      )}
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2">
        <Hand className="size-3.5 text-warning" />
        <span className="text-xs font-semibold">Approval requested</span>
        <Badge tone="outline">{item.toolName}</Badge>
        <div className="flex-1" />
        {item.decision ? (
          <Badge tone={item.decision === "allow" ? "success" : "danger"}>{item.decision === "allow" ? "Allowed" : "Denied"}</Badge>
        ) : (
          <div className="flex gap-1.5">
            <Button size="sm" variant="secondary" disabled={deciding} onClick={() => onDecide?.(item.approvalId, "deny")}>
              Deny
            </Button>
            <Button size="sm" variant="success" disabled={deciding} onClick={() => onDecide?.(item.approvalId, "allow")}>
              {deciding ? <Spinner /> : <Check />}
              Allow
            </Button>
          </div>
        )}
      </div>
      <div className="mt-1.5 font-mono text-[11px] text-fg-muted">{item.summary}</div>
      {details?.input !== undefined && (
        <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg-muted">
          {stringify(details.input)}
        </pre>
      )}
    </div>
  )
}
