import type { HarnessRateLimits, RateLimitWindow } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { HARNESS_LABELS } from "@/components/status"
import { Tooltip } from "@/components/ui/misc"
import { q } from "@/lib/queries"
import { cn } from "@/lib/utils"

const resetsIn = (iso: string | undefined) => {
  if (!iso) return ""
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  if (mins <= 0) return "resets now"
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.round(mins / 60)}h`
  return `resets ${new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`
}

const tone = (w: RateLimitWindow) => (w.usedPercent >= 90 ? "bg-danger" : w.usedPercent >= 70 ? "bg-warning" : "bg-success")

/** Subscription limits the harnesses reported with their last turns, one row per harness. */
export const UsageLimits = () => {
  const limits = useQuery(q.limits())
  const rows = [...(limits.data ?? [])].sort((a, b) => a.harness.localeCompare(b.harness))
  if (rows.length === 0) return null
  return (
    <div className="mb-2 space-y-1.5" data-testid="usage-limits">
      {rows.map((l) => (
        <LimitRow key={l.harness} limits={l} />
      ))}
    </div>
  )
}

const LimitRow = ({ limits }: { limits: HarnessRateLimits }) => (
  <Tooltip
    content={
      <div className="space-y-0.5">
        {limits.windows.map((w) => (
          <div key={w.id}>
            {w.label}: {Math.round(w.usedPercent)}% used{w.resetsAt ? `, ${resetsIn(w.resetsAt)}` : ""}
          </div>
        ))}
        {limits.limited && <div className="text-danger">Limit reached</div>}
      </div>
    }
  >
    <div className="flex cursor-default items-center gap-2">
      <span className={cn("w-14 shrink-0 truncate", limits.limited && "text-danger")}>{HARNESS_LABELS[limits.harness]}</span>
      <div className="flex min-w-0 flex-1 gap-1.5">
        {limits.windows.slice(0, 2).map((w) => (
          <div key={w.id} className="min-w-0 flex-1" aria-label={`${w.label} ${Math.round(w.usedPercent)}% used`}>
            <div className="h-1 overflow-hidden rounded-full bg-bg-muted">
              <div className={cn("h-full", tone(w))} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
            </div>
          </div>
        ))}
      </div>
      <span className="shrink-0 tabular-nums">{Math.round(Math.max(...limits.windows.map((w) => w.usedPercent)))}%</span>
    </div>
  </Tooltip>
)
