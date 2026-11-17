import type { ActivityEvent } from "@agentdesk/contracts"
import { Bot, Check, CircleDot, GitBranch, GitPullRequest, Hand, Link2, Play, User, Workflow, X } from "lucide-react"
import { useState } from "react"
import { cn, relativeTime } from "@/lib/utils"

type Tone = "neutral" | "success" | "danger" | "accent"

const presentation = (e: ActivityEvent): { icon: React.ReactNode; tone: Tone } => {
  const k = e.kind
  if (k === "approval.decided") {
    const denied = /^(Denied|Rejected)\b/.test(e.message)
    return { icon: denied ? <X /> : <Check />, tone: denied ? "danger" : "success" }
  }
  if (k.endsWith(".failed") || k.endsWith(".interrupted")) return { icon: k.startsWith("step") || k.startsWith("run") ? <Workflow /> : <Bot />, tone: "danger" }
  if (k.startsWith("session")) return { icon: <Bot />, tone: k === "session.started" ? "accent" : "neutral" }
  if (k.startsWith("run") || k.startsWith("step")) return { icon: k.endsWith("started") ? <Play /> : <Workflow />, tone: k.endsWith("completed") ? "success" : "neutral" }
  if (k.startsWith("approval")) return { icon: <Hand />, tone: "neutral" }
  if (k.startsWith("pr")) return { icon: <GitPullRequest />, tone: "accent" }
  if (k.startsWith("workspace")) return { icon: <GitBranch />, tone: "neutral" }
  if (k.startsWith("source") || k.startsWith("jira")) return { icon: <Link2 />, tone: "neutral" }
  if (k.startsWith("ticket")) return { icon: <CircleDot />, tone: "neutral" }
  return { icon: <User />, tone: "neutral" }
}

const toneClass: Record<Tone, string> = {
  neutral: "bg-bg-muted text-fg-muted",
  success: "bg-success/15 text-success",
  danger: "bg-danger/15 text-danger",
  accent: "bg-accent/15 text-accent"
}

/**
 * "Approved: Bash: <long command>" → title "Approved · Bash", detail "<long command>".
 * Messages with a short label before ": " and a long tail get the same split.
 */
const splitMessage = (message: string): { title: string; detail?: string; command?: boolean } => {
  const approval = /^(Approved|Denied|Rejected): ([^:\n]{1,40}): ([\s\S]+)$/.exec(message)
  if (approval) return { title: `${approval[1]} · ${approval[2]}`, detail: approval[3]!.trim(), command: true }
  const i = message.indexOf(": ")
  if (i > 0 && i <= 40 && (message.length > 120 || message.includes("\n"))) {
    return { title: message.slice(0, i), detail: message.slice(i + 2).trim() }
  }
  return { title: message }
}

const dayLabel = (iso: string) => {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return "Today"
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })
}

export const ActivityTimeline = ({ events, groupByDay = false }: { events: ReadonlyArray<ActivityEvent>; groupByDay?: boolean }) => {
  if (events.length === 0) return <p className="text-sm text-fg-subtle">No activity yet.</p>
  const groups = groupByDay
    ? events.reduce<Array<{ day: string; items: Array<ActivityEvent> }>>((out, e) => {
        const day = dayLabel(e.at)
        if (out.at(-1)?.day === day) out.at(-1)!.items.push(e)
        else out.push({ day, items: [e] })
        return out
      }, [])
    : [{ day: "", items: [...events] }]
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.day || "all"}>
          {g.day && <h3 className="mb-3 text-xs font-medium text-fg-muted">{g.day}</h3>}
          <ol>
            {g.items.map((e, i) => (
              <Entry key={e.id} event={e} last={i === g.items.length - 1} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

const Entry = ({ event, last }: { event: ActivityEvent; last: boolean }) => {
  const [open, setOpen] = useState(false)
  const { icon, tone } = presentation(event)
  const { title, detail, command } = splitMessage(event.message)
  const long = !!detail && (detail.length > 160 || detail.includes("\n"))
  return (
    <li className="grid grid-cols-[24px_1fr] gap-x-3">
      <div className="flex flex-col items-center">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5", toneClass[tone])}>{icon}</span>
        {!last && <span className="my-1 w-px flex-1 bg-border" />}
      </div>
      <div className={cn("min-w-0", last ? "pb-1" : "pb-5")}>
        <div className="flex min-h-6 flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium text-fg">{title}</span>
          <span className="text-[11px] text-fg-subtle" title={`${event.kind} · ${event.at}`}>
            {event.actor} · <time dateTime={event.at}>{relativeTime(event.at)}</time>
          </span>
        </div>
        {detail && (
          <div className="mt-1.5">
            <pre
              className={cn(
                "overflow-hidden rounded-md border bg-bg-subtle px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-fg-muted",
                !open && long && "line-clamp-2"
              )}
            >
              {detail}
            </pre>
            {long && (
              <button onClick={() => setOpen(!open)} className="mt-1 text-[11px] text-fg-subtle hover:text-fg">
                {open ? "Show less" : command ? "Show full command" : "Show more"}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  )
}
