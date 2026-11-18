import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Check, Hand, Inbox as InboxIcon, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState, Spinner } from "@/components/ui/misc"
import { AgentCard } from "@/features/agents/agent-card"
import { agentGroup, isSessionUnread } from "@/lib/agent-state"
import { useUi } from "@/lib/store"
import { ActivityTimeline } from "@/features/ticket/activity-timeline"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"
import { relativeTime } from "@/lib/utils"

export const Route = createFileRoute("/inbox")({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.approvals(true)),
  component: Inbox
})

const NOTABLE = /^(session\.(ended|interrupted)|run\.|(source|jira)\.sync\.failed|pr\.|step\.failed)/

function Inbox() {
  const pending = useQuery(q.approvals(true))
  const tickets = useQuery(q.tickets())
  const activity = useQuery(q.activity())
  const sessions = useQuery(q.sessions(false))
  const projects = useQuery(q.projects())
  const seen = useUi((s) => s.sessionSeen)
  const markRead = useUi((s) => s.markSessionRead)
  const [unreadOnly, setUnreadOnly] = useState(true)
  const updates = (sessions.data ?? [])
    .filter((s) => (agentGroup(s.state) !== "working" || isSessionUnread(s, seen)) && (!unreadOnly || isSessionUnread(s, seen)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const qc = useQueryClient()
  const byId = useMemo(() => new Map((tickets.data ?? []).map((t) => [t.id, t])), [tickets.data])
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "allow" | "deny" }) => api.decide(id, decision),
    onSettled: () => qc.invalidateQueries({ queryKey: ["approvals"] })
  })
  const notable = (activity.data ?? []).filter((a) => NOTABLE.test(a.kind)).slice(0, 40)

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center border-b px-4">
        <h1 className="text-[13px] font-semibold">Inbox</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-6">
          <section>
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
              <Hand className="size-3.5" /> Waiting for you
              {pending.data && <Badge tone="warning">{pending.data.length}</Badge>}
            </h2>
            {pending.isLoading ? (
              <Spinner />
            ) : pending.data?.length === 0 ? (
              <EmptyState icon={<InboxIcon />} title="Nothing needs your attention">
                Agent approval requests and workflow gates appear here.
              </EmptyState>
            ) : (
              <div className="divide-y rounded-lg border">
                {pending.data!.map((a) => {
                  const t = byId.get(a.ticketId)
                  return (
                    <div key={a.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="inbox-approval">
                      <Hand className="size-4 shrink-0 text-warning" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">{a.title}</div>
                        <div className="text-[11px] text-fg-subtle">
                          {t ? (
                            <Link
                              to="/issues/$ticketId"
                              params={{ ticketId: t.id }}
                              search={{ tab: a.kind === "tool" || a.kind === "question" ? "agent" : "workflow" }}
                              className="hover:underline"
                            >
                              {t.identifier} · {t.title}
                            </Link>
                          ) : (
                            a.ticketId
                          )}{" "}
                          · {a.kind.replace("_", " ")} · {relativeTime(a.createdAt)}
                        </div>
                      </div>
                      {a.kind === "question" && t ? (
                        // Questions need their options: answer them in the conversation.
                        <Link to="/issues/$ticketId" params={{ ticketId: t.id }} search={{ tab: "agent" }}>
                          <Button size="sm" variant="success">
                            Answer
                          </Button>
                        </Link>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            disabled={decide.isPending}
                            variant="secondary"
                            onClick={() => decide.mutate({ id: a.id, decision: "deny" })}
                          >
                            <X /> Deny
                          </Button>
                          <Button
                            size="sm"
                            disabled={decide.isPending}
                            variant="success"
                            onClick={() => decide.mutate({ id: a.id, decision: "allow" })}
                          >
                            <Check /> Approve
                          </Button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {decide.error && <p className="mt-2 text-xs text-danger">{(decide.error as Error).message}</p>}
          </section>
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="mr-auto text-xs font-semibold uppercase tracking-wide text-fg-muted">Agent updates · {updates.length}</h2>
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
              </label>
              <Button size="sm" variant="ghost" onClick={() => updates.forEach((s) => markRead(s.id, s.lastEventId))}>
                Mark all read
              </Button>
            </div>
            <div className="space-y-2" data-testid="inbox-agent-updates">
              {updates.map((s) => (
                <AgentCard
                  key={s.id}
                  session={s}
                  ticket={byId.get(s.ticketId)}
                  projectName={projects.data?.find((p) => p.id === byId.get(s.ticketId)?.projectId)?.name}
                  list
                />
              ))}
              {!sessions.isPending && updates.length === 0 && (
                <p className="text-xs text-fg-subtle">{unreadOnly ? "No unread agent updates." : "No agent updates yet."}</p>
              )}
            </div>
          </section>
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">Recent updates</h2>
            <ActivityTimeline events={notable} />
          </section>
        </div>
      </div>
    </div>
  )
}
