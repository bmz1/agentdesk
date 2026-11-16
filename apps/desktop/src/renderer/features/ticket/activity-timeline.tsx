import type { ActivityEvent } from "@agentdesk/contracts"
import { Bot, CircleDot, GitBranch, Hand, Link2, User } from "lucide-react"
import { relativeTime } from "@/lib/utils"

const iconFor = (kind: string) => {
  if (kind.startsWith("session")) return <Bot />
  if (kind.startsWith("approval")) return <Hand />
  if (kind.startsWith("workspace") || kind.startsWith("pr")) return <GitBranch />
  if (kind.startsWith("jira")) return <Link2 />
  if (kind.startsWith("ticket")) return <CircleDot />
  return <User />
}

export const ActivityTimeline = ({ events }: { events: ReadonlyArray<ActivityEvent> }) => (
  <ol className="relative space-y-3 border-l pl-4">
    {events.map((e) => (
      <li key={e.id} className="relative">
        <span className="absolute -left-[23px] flex size-3.5 items-center justify-center rounded-full border bg-bg text-fg-subtle [&_svg]:size-2.5">
          {iconFor(e.kind)}
        </span>
        <div className="text-[13px]">{e.message}</div>
        <div className="text-[11px] text-fg-subtle">
          {e.actor} · {e.kind} · <time title={e.at}>{relativeTime(e.at)}</time>
        </div>
      </li>
    ))}
    {events.length === 0 && <li className="text-xs text-fg-subtle">No activity yet.</li>}
  </ol>
)
