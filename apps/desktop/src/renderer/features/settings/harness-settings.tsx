import { useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react"
import { HARNESS_LABELS } from "@/components/status"
import { Button } from "@/components/ui/button"
import { Section, Spinner } from "@/components/ui/misc"
import { api } from "@/lib/api"
import { q, qk } from "@/lib/queries"

export const HarnessSettings = () => {
  const harnesses = useQuery(q.harnesses())
  const qc = useQueryClient()
  return (
    <Section
      title="Agent harnesses"
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void api.harnesses(true).then((d) => qc.setQueryData(qk.harnesses, d))}
        >
          <RefreshCw /> Re-detect
        </Button>
      }
    >
      {harnesses.isLoading ? (
        <Spinner />
      ) : (
        <div className="divide-y">
          {(harnesses.data ?? []).map((h) => (
            <div key={h.id} className="flex items-center gap-3 py-2 text-xs" data-testid={`harness-${h.id}`}>
              {h.installed ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-fg-subtle" />}
              <span className="w-28 font-medium">{HARNESS_LABELS[h.id]}</span>
              <span className="w-24 font-mono text-fg-muted">{h.version ?? "—"}</span>
              <span className="min-w-0 flex-1 truncate text-fg-subtle" title={h.detail}>
                {h.binary ?? h.detail}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11px] text-fg-subtle">
        Harnesses run with their own supported login. AgentDesk never reads, copies or proxies subscription credentials, and
        never forwards Jira/Git tokens into agent processes.
      </p>
    </Section>
  )
}
