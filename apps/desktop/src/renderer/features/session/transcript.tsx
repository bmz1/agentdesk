import { useState } from "react"
import type { AgentQuestion, PlanItem, QuestionAnswers, TokenUsage } from "@agentdesk/contracts"
import { Check, Circle, CircleAlert, CircleCheck, CircleDot, CircleHelp, CircleSlash, Hand, Info, ListChecks, LoaderCircle, Terminal, Wrench, X } from "lucide-react"
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
import { guessLanguage } from "@/lib/highlight"
import { shortcutHint } from "@/lib/keymap"
import { cn } from "@/lib/utils"
import { AttachmentImage } from "./images"
import { Code, Markdown } from "./markdown"
import type { TranscriptItem } from "./transcript-model"

/** How the user answered: "session" allows matching requests for the rest of the session. */
export interface DecideOptions {
  readonly scope?: "once" | "session"
  readonly answers?: QuestionAnswers
}
export type DecideFn = (approvalId: string, decision: "allow" | "deny", options?: DecideOptions) => void

export interface TranscriptProps {
  items: ReadonlyArray<TranscriptItem>
  /** The agent's latest plan or to-do list. */
  plan?: ReadonlyArray<PlanItem>
  /** The agent is busy: show a working indicator after the last output. */
  working?: boolean
  onDecide?: DecideFn
  deciding?: string | null
  /** Older events exist beyond the loaded page. */
  hasEarlier?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => void
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
export const Transcript = ({ items, plan, working, onDecide, deciding, hasEarlier, loadingEarlier, onLoadEarlier }: TranscriptProps) => {
  const exchanges = groupExchanges(items)
  const pending = items.findLast((i): i is Item<"approval"> => i.kind === "approval" && !i.decision)
  const last = items.at(-1)
  const showWorking = working && !pending && !(last?.kind === "assistant" && last.streaming)

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport data-testid="transcript">
          {plan && plan.length > 0 && <PlanChecklist items={plan} />}
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-6 py-6">
            {hasEarlier && onLoadEarlier && (
              <Button variant="ghost" size="sm" className="self-center text-xs text-muted-foreground" onClick={onLoadEarlier} disabled={loadingEarlier} data-testid="load-earlier">
                {loadingEarlier ? <LoaderCircle className="animate-spin" /> : null}
                Load earlier messages
              </Button>
            )}
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
          {pending &&
            (pending.question ? (
              <PendingQuestion key={pending.approvalId} item={pending} questions={pending.question} onDecide={onDecide} deciding={deciding === pending.approvalId} />
            ) : (
              <PendingApproval item={pending} onDecide={onDecide} deciding={deciding === pending.approvalId} />
            ))}
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

/** "12.3k" style token counts. */
export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const tokensLabel = (u: TokenUsage | undefined) => {
  if (!u) return undefined
  const read = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  return `${formatTokens(read)} in · ${formatTokens(u.outputTokens)} out`
}

const TurnFooter = ({ item }: { item: Item<"turn"> }) => {
  const meta = [
    item.status === "success" ? "Done" : item.status.replace(/_/g, " "),
    item.durationMs !== undefined && `${(item.durationMs / 1000).toFixed(1)}s`,
    tokensLabel(item.usage),
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

const toolFilePath = (input: unknown) => {
  if (!input || typeof input !== "object") return undefined
  const o = input as Record<string, unknown>
  const v = o.file_path ?? o.notebook_path ?? o.path
  return typeof v === "string" ? v : undefined
}

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
            {step.input !== undefined && <Code code={stringify(step.input)} title="Input" lang={guessLanguage(stringify(step.input))} />}
            {step.result !== undefined && (
              <Code
                code={stringify(step.result) || "(no output)"}
                title={step.isError ? "Error" : "Output"}
                tone={step.isError ? "destructive" : "default"}
                lang={step.isError ? undefined : guessLanguage(stringify(step.result), toolFilePath(step.input))}
              />
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      )
    }
    case "approval":
      if (step.question) {
        const answered = (step.question ?? []).map((q) => (step.answers?.[q.id] ?? []).join(", ")).filter(Boolean).join(" · ")
        return (
          <TraceLine status={step.decision ? (step.decision === "deny" ? "error" : undefined) : "pending"}>
            <TraceIcon>
              <CircleHelp />
            </TraceIcon>
            <TraceTitle>{step.decision ? (step.decision === "allow" ? "Answered" : "Declined to answer") : "Waiting for your answer"}</TraceTitle>
            <TraceDescription className="truncate text-[12px]" title={step.summary}>
              {step.summary}
              {answered && <span className="text-foreground"> → {answered}</span>}
            </TraceDescription>
          </TraceLine>
        )
      }
      return (
        <TraceLine status={step.decision ? (step.decision === "deny" ? "error" : undefined) : "pending"}>
          <TraceIcon>
            <Hand />
          </TraceIcon>
          <TraceTitle>
            {step.decision ? (step.decision === "allow" ? (step.scope === "session" ? "Allowed for the session" : "Allowed") : "Denied") : "Waiting for approval"} · {step.toolName}
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
  onDecide?: DecideFn
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
            <Button variant="outline" disabled={deciding} onClick={() => onDecide?.(item.approvalId, "deny")} title={`Deny (${shortcutHint("deny")})`}>
              <X /> Deny
            </Button>
            {item.canAllowForSession && (
              <Button
                variant="secondary"
                disabled={deciding}
                onClick={() => onDecide?.(item.approvalId, "allow", { scope: "session" })}
                title={`Allow, and don't ask again for this in this session (${shortcutHint("approveSession")})`}
                data-testid="approve-session"
              >
                Allow for session
              </Button>
            )}
            <Button disabled={deciding} onClick={() => onDecide?.(item.approvalId, "allow")} title={`Allow (${shortcutHint("approve")})`}>
              {deciding ? <LoaderCircle className="animate-spin" /> : <CircleCheck />} Allow
            </Button>
          </div>
        </div>
        {details?.input !== undefined && <Code code={stringify(details.input)} />}
      </div>
    </div>
  )
}

/**
 * The agent asks the user something (Claude AskUserQuestion, Codex request_user_input,
 * OpenCode question). Options are one click; "Other" takes free text when the agent allows it.
 */
const PendingQuestion = ({
  item,
  questions,
  onDecide,
  deciding
}: {
  item: Item<"approval">
  questions: ReadonlyArray<AgentQuestion>
  onDecide?: DecideFn
  deciding?: boolean
}) => {
  const [picked, setPicked] = useState<Record<string, ReadonlyArray<string>>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answerOf = (q: AgentQuestion) => [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id]!.trim()] : [])]
  const complete = questions.length > 0 && questions.every((q) => answerOf(q).length > 0)
  const submit = () => complete && onDecide?.(item.approvalId, "allow", { answers: Object.fromEntries(questions.map((q) => [q.id, answerOf(q)])) })
  const toggle = (q: AgentQuestion, label: string) =>
    setPicked((p) => {
      const current = p[q.id] ?? []
      if (!q.multiSelect) return { ...p, [q.id]: current[0] === label ? [] : [label] }
      return { ...p, [q.id]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] }
    })
  return (
    <div className="sticky bottom-2 isolate z-20 mx-auto w-full max-w-3xl px-6 pt-2">
      <div className="w-full rounded-2xl border border-primary/40 bg-bg-elevated p-4 text-sm shadow-lg ring-1 ring-foreground/5" data-testid="question-card">
        <div className="mb-3 flex items-center gap-2 font-medium">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <CircleHelp className="size-4" />
          </div>
          {questions.length === 1 ? "The agent has a question" : `The agent has ${questions.length} questions`}
        </div>
        <div className="flex flex-col gap-4">
          {questions.map((q) => (
            <fieldset key={q.id} className="flex flex-col gap-2">
              <legend className="mb-1.5">
                {q.header && <span className="mr-2 rounded bg-bg-muted px-1.5 py-0.5 text-[11px] text-fg-muted">{q.header}</span>}
                {q.question}
                {q.multiSelect && <span className="ml-1 text-xs text-fg-subtle">(choose any)</span>}
              </legend>
              {q.options.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {q.options.map((o) => {
                    const on = (picked[q.id] ?? []).includes(o.label)
                    return (
                      <Button
                        key={o.label}
                        size="sm"
                        variant={on ? "default" : "outline"}
                        aria-pressed={on}
                        title={o.description}
                        onClick={() => toggle(q, o.label)}
                        data-testid="question-option"
                      >
                        {on && <Check />}
                        {o.label}
                      </Button>
                    )
                  })}
                </div>
              )}
              {q.allowOther && (
                <input
                  className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
                  placeholder={q.options.length ? "Or type another answer…" : "Your answer…"}
                  value={other[q.id] ?? ""}
                  onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      submit()
                    }
                  }}
                  data-testid="question-other"
                />
              )}
            </fieldset>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" disabled={deciding} onClick={() => onDecide?.(item.approvalId, "deny")}>
            Skip
          </Button>
          <Button disabled={deciding || !complete} onClick={submit} data-testid="question-submit">
            {deciding ? <LoaderCircle className="animate-spin" /> : <CircleCheck />} Send {questions.length === 1 ? "answer" : "answers"}
          </Button>
        </div>
      </div>
    </div>
  )
}

const PLAN_ICONS = { completed: CircleCheck, in_progress: CircleDot, pending: Circle, cancelled: CircleSlash } as const

/** The agent's plan or to-do list, pinned above the conversation; collapsed to its progress by default. */
const PlanChecklist = ({ items }: { items: ReadonlyArray<PlanItem> }) => {
  const [open, setOpen] = useState(false)
  const counted = items.filter((i) => i.status !== "cancelled")
  const done = counted.filter((i) => i.status === "completed").length
  const current = counted.find((i) => i.status === "in_progress")
  return (
    <div className="sticky top-0 z-10 mx-auto w-full max-w-3xl px-6 pt-2" data-testid="plan">
      <div className="rounded-xl border border-border bg-bg-elevated/95 text-xs shadow-sm backdrop-blur">
        <button className="flex w-full items-center gap-2 px-3 py-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ListChecks className="size-3.5 shrink-0 text-fg-muted" />
          <span className="font-medium">
            Plan {done}/{counted.length}
          </span>
          <span className="h-1 w-16 overflow-hidden rounded-full bg-bg-muted">
            <span className="block h-full bg-success" style={{ width: `${counted.length ? (done / counted.length) * 100 : 0}%` }} />
          </span>
          {current && <span className="min-w-0 truncate text-fg-muted">{current.text}</span>}
        </button>
        {open && (
          <ol className="flex flex-col gap-1 border-t border-border px-3 py-2">
            {items.map((i, n) => {
              const Icon = PLAN_ICONS[i.status]
              return (
                <li key={n} className={cn("flex items-start gap-2", i.status === "completed" && "text-fg-muted line-through", i.status === "cancelled" && "text-fg-subtle line-through")}>
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", i.status === "in_progress" && "text-primary", i.status === "completed" && "text-success")} />
                  {i.text}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}
