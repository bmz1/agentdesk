import { useState } from "react"
import { CircleAlert, CircleCheck, Hand, Info, LoaderCircle, Terminal, Wrench, X } from "lucide-react"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from "@/components/ui/message-scroller"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle
} from "@/components/ui/trace"
import { cn } from "@/lib/utils"
import { AttachmentImage } from "./images"
import { Code, Markdown } from "./markdown"
import type { TranscriptItem } from "./transcript-model"

export interface TranscriptProps {
  items: ReadonlyArray<TranscriptItem>
  /** The agent is busy: show a working indicator after the last output. */
  working?: boolean
  onDecide?: (approvalId: string, decision: "allow" | "deny") => void
  deciding?: string | null
}

type Item<K extends TranscriptItem["kind"]> = Extract<TranscriptItem, { kind: K }>
type Step = Item<"reasoning" | "tool" | "status" | "approval">

/** A user prompt, or everything the agent did in response to one. */
type Exchange = { kind: "user"; key: string; item: Item<"user"> } | { kind: "agent"; key: string; items: Array<TranscriptItem> }

const groupExchanges = (items: ReadonlyArray<TranscriptItem>) =>
  items.reduce<Array<Exchange>>((out, item) => {
    if (item.kind === "user") {
      out.push({ kind: "user", key: item.key, item })
      return out
    }
    const last = out.at(-1)
    if (last?.kind === "agent") last.items.push(item)
    else out.push({ kind: "agent", key: item.key, items: [item] })
    return out
  }, [])

/** Text splits an agent response into runs of steps; each run becomes one Trace. */
const groupBlocks = (items: ReadonlyArray<TranscriptItem>) =>
  items.reduce<Array<Item<"assistant"> | Item<"turn"> | Item<"image"> | Array<Step>>>((blocks, item) => {
    if (item.kind === "assistant" || item.kind === "turn" || item.kind === "image") {
      if (item.kind !== "assistant" || item.text.trim() || item.streaming) blocks.push(item)
      return blocks
    }
    if (item.kind === "user") return blocks
    const last = blocks.at(-1)
    if (Array.isArray(last)) last.push(item)
    else blocks.push([item])
    return blocks
  }, [])

/** Structured agent session, laid out with the shadcn chat components. */
export const Transcript = ({ items, working, onDecide, deciding }: TranscriptProps) => {
  const exchanges = groupExchanges(items)
  const pending = items.findLast((i): i is Item<"approval"> => i.kind === "approval" && !i.decision)
  const last = items.at(-1)
  const showWorking = working && !pending && !(last?.kind === "assistant" && last.streaming)

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport data-testid="transcript">
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
            {exchanges.map((x) => (
              <MessageScrollerItem key={x.key} messageId={x.key} scrollAnchor={x.kind === "user"}>
                {x.kind === "user" ? <UserMessage item={x.item} /> : <AgentMessage items={x.items} />}
              </MessageScrollerItem>
            ))}
            {showWorking && (
              <MessageScrollerItem messageId="working">
                <Trace>
                  <TraceLine status="running">
                    <TraceIcon>
                      <LoaderCircle className="animate-spin" />
                    </TraceIcon>
                    <TraceTitle>Working</TraceTitle>
                  </TraceLine>
                </Trace>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
          {pending && <PendingApproval item={pending} onDecide={onDecide} deciding={deciding === pending.approvalId} />}
        </MessageScrollerViewport>
        <MessageScrollerButton className="bottom-4" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

/** Long prompts (the generated ticket brief) collapse so the conversation stays readable. */
const UserMessage = ({ item }: { item: Item<"user"> }) => {
  const long = item.text.length > 600 || item.text.split("\n").length > 10
  const [open, setOpen] = useState(false)
  return (
    <Message align="end">
      <MessageContent>
        {item.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {item.images.map((img) => (
              <AttachmentImage key={img.id} image={img} className="[&_img]:max-h-48" />
            ))}
          </div>
        )}
        <Bubble align="end" variant="muted">
          <BubbleContent className={cn("relative rounded-2xl whitespace-pre-wrap", long && !open && "max-h-56")}>
            {item.text}
            {long && !open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-muted to-transparent" />}
          </BubbleContent>
          {long && (
            <button onClick={() => setOpen(!open)} className="self-end px-2 text-xs text-muted-foreground hover:text-foreground">
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </Bubble>
      </MessageContent>
    </Message>
  )
}

const AgentMessage = ({ items }: { items: ReadonlyArray<TranscriptItem> }) => (
  <Message>
    <MessageContent>
      {groupBlocks(items).map((block, i) => {
        if (Array.isArray(block)) {
          return (
            <Trace key={block[0]!.key}>
              {block.map((step) => (
                <StepLine key={step.key} step={step} />
              ))}
            </Trace>
          )
        }
        if (block.kind === "turn") return <TurnFooter key={block.key} item={block} />
        if (block.kind === "image") return <AttachmentImage key={block.key} image={block.image} className="w-fit" />
        return (
          <div key={block.key ?? i} className="text-[14px]">
            <Markdown text={block.text} />
            {block.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-primary align-middle" />}
          </div>
        )
      })}
    </MessageContent>
  </Message>
)

const TurnFooter = ({ item }: { item: Item<"turn"> }) => {
  const meta = [
    item.status === "success" ? "Done" : item.status.replace(/_/g, " "),
    item.durationMs !== undefined && `${(item.durationMs / 1000).toFixed(1)}s`,
    item.costUsd ? `$${item.costUsd.toFixed(3)}` : undefined
  ].filter(Boolean)
  return (
    <MessageFooter className={cn("gap-1.5 px-0 font-normal", item.status !== "success" && "text-danger")}>
      {item.status === "success" ? <CircleCheck className="size-3.5" /> : <CircleAlert className="size-3.5" />}
      {meta.join(" · ")}
    </MessageFooter>
  )
}

const stringify = (u: unknown) => (typeof u === "string" ? u : JSON.stringify(u, null, 2))

const toolSummary = (input: unknown) => {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>
    const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description
    if (typeof v === "string") return v
    if (Array.isArray(v)) return v.join(" ")
  }
  return undefined
}

const StepLine = ({ step }: { step: Step }) => {
  switch (step.kind) {
    case "reasoning":
      return (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <CircleCheck />
              </TraceIcon>
              <TraceTitle>Thought</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-[13px] whitespace-pre-wrap">{step.text}</TraceCollapsibleContent>
        </TraceCollapsible>
      )
    case "tool": {
      const shell = /bash|shell|command|exec/i.test(step.name)
      const summary = toolSummary(step.input)
      const status = !step.done ? "running" : step.isError ? "error" : undefined
      return (
        <TraceCollapsible>
          <TraceCollapsibleTrigger>
            <TraceLine status={status}>
              <TraceIcon>{status === "running" ? <LoaderCircle className="animate-spin" /> : status === "error" ? <CircleAlert /> : shell ? <Terminal /> : <Wrench />}</TraceIcon>
              <TraceTitle>
                {step.name}
                {summary && <span className="ml-1.5 font-mono text-[12px] opacity-80">{summary}</span>}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>
            {step.input !== undefined && <Code code={stringify(step.input)} title="Input" />}
            {step.result !== undefined && (
              <Code code={stringify(step.result) || "(no output)"} title={step.isError ? "Error" : "Output"} tone={step.isError ? "destructive" : "default"} />
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )
    }
    case "approval":
      return (
        <TraceLine status={step.decision ? (step.decision === "deny" ? "error" : undefined) : "pending"}>
          <TraceIcon>
            <Hand />
          </TraceIcon>
          <TraceTitle>
            {step.decision ? (step.decision === "allow" ? "Allowed" : "Denied") : "Waiting for approval"} · {step.toolName}
          </TraceTitle>
          <TraceDescription className="truncate font-mono text-[12px]">{step.summary}</TraceDescription>
        </TraceLine>
      )
    case "status":
      return (
        <TraceLine status={step.tone === "danger" ? "error" : undefined} className={cn(step.tone === "warning" && "text-warning")}>
          <TraceIcon>{step.tone === "danger" ? <CircleAlert /> : <Info />}</TraceIcon>
          <TraceTitle className="whitespace-normal">{step.text}</TraceTitle>
        </TraceLine>
      )
  }
}

/** Pinned above the composer, like the template's question card, until decided. */
const PendingApproval = ({
  item,
  onDecide,
  deciding
}: {
  item: Item<"approval">
  onDecide?: (id: string, d: "allow" | "deny") => void
  deciding?: boolean
}) => {
  const details = item.details as { input?: unknown } | undefined
  return (
    <div className="sticky bottom-2 isolate z-20 mx-auto w-full max-w-3xl px-6 pt-2">
      <div
        className="w-full rounded-2xl border border-warning/40 bg-bg-elevated p-4 text-sm shadow-lg ring-1 ring-foreground/5"
        data-testid="approval-card"
      >
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
            <Hand className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              Allow <span className="font-mono text-[13px]">{item.toolName}</span>?
            </div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground" title={item.summary}>
              {item.summary}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" disabled={deciding} onClick={() => onDecide?.(item.approvalId, "deny")}>
              <X /> Deny
            </Button>
            <Button disabled={deciding} onClick={() => onDecide?.(item.approvalId, "allow")}>
              {deciding ? <LoaderCircle className="animate-spin" /> : <CircleCheck />} Allow
            </Button>
          </div>
        </div>
        {details?.input !== undefined && <Code code={stringify(details.input)} />}
      </div>
    </div>
  )
}
