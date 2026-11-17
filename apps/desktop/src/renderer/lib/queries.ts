import { type AgentSession, type ChangeNotice, LIVE_SESSION_STATES } from "@agentdesk/contracts"
import { QueryClient, queryOptions } from "@tanstack/react-query"
import { api, type TicketQuery } from "./api"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false },
    mutations: { retry: 0 }
  }
})

/** Query key factory. Route loaders and components share these, never ad-hoc keys. */
export const qk = {
  info: ["info"] as const,
  harnessSettings: ["settings", "harnesses"] as const,
  harnesses: ["harnesses"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  tickets: (q: TicketQuery = {}) => ["tickets", "list", q] as const,
  ticket: (id: string) => ["tickets", "detail", id] as const,
  ticketActivity: (id: string) => ["tickets", "detail", id, "activity"] as const,
  ticketSessions: (id: string) => ["tickets", "detail", id, "sessions"] as const,
  ticketApprovals: (id: string) => ["tickets", "detail", id, "approvals"] as const,
  ticketDiff: (id: string) => ["tickets", "detail", id, "diff"] as const,
  ticketWorkspace: (id: string) => ["tickets", "detail", id, "workspace"] as const,
  ticketFiles: (id: string) => ["tickets", "detail", id, "files"] as const,
  ticketFile: (id: string, path: string) => ["tickets", "detail", id, "files", path] as const,
  ticketRuns: (id: string) => ["tickets", "detail", id, "runs"] as const,
  sessions: (active: boolean) => ["sessions", { active }] as const,
  session: (id: string) => ["sessions", "detail", id] as const,
  approvals: (pending: boolean) => ["approvals", { pending }] as const,
  activity: ["activity"] as const,
  runs: (status?: string) => ["runs", { status }] as const,
  run: (id: string) => ["runs", "detail", id] as const,
  workflows: ["workflows"] as const,
  workflow: (id: string) => ["workflows", id] as const,
  sources: ["sources"] as const,
  sourceConnections: ["sources", "connections"] as const
}

export const q = {
  harnessSettings: () => queryOptions({ queryKey: qk.harnessSettings, queryFn: api.harnessSettings }),
  info: () => queryOptions({ queryKey: qk.info, queryFn: api.info, refetchInterval: 15_000 }),
  harnesses: () => queryOptions({ queryKey: qk.harnesses, queryFn: () => api.harnesses(), staleTime: 60_000 }),
  projects: () => queryOptions({ queryKey: qk.projects, queryFn: api.projects }),
  project: (id: string) => queryOptions({ queryKey: qk.project(id), queryFn: () => api.project(id) }),
  tickets: (query: TicketQuery = {}) => queryOptions({ queryKey: qk.tickets(query), queryFn: () => api.tickets(query) }),
  ticket: (id: string) => queryOptions({ queryKey: qk.ticket(id), queryFn: () => api.ticket(id) }),
  ticketActivity: (id: string) => queryOptions({ queryKey: qk.ticketActivity(id), queryFn: () => api.ticketActivity(id) }),
  ticketSessions: (id: string) => queryOptions({ queryKey: qk.ticketSessions(id), queryFn: () => api.ticketSessions(id) }),
  ticketApprovals: (id: string) => queryOptions({ queryKey: qk.ticketApprovals(id), queryFn: () => api.ticketApprovals(id) }),
  ticketDiff: (id: string) => queryOptions({ queryKey: qk.ticketDiff(id), queryFn: () => api.ticketDiff(id), staleTime: 2_000 }),
  ticketWorkspace: (id: string) => queryOptions({ queryKey: qk.ticketWorkspace(id), queryFn: () => api.ticketWorkspace(id) }),
  ticketFiles: (id: string) => queryOptions({ queryKey: qk.ticketFiles(id), queryFn: () => api.ticketFiles(id), refetchInterval: 10_000 }),
  ticketFile: (id: string, path: string) =>
    queryOptions({ queryKey: qk.ticketFile(id, path), queryFn: () => api.ticketFile(id, path), refetchInterval: 10_000 }),
  ticketRuns: (id: string) => queryOptions({ queryKey: qk.ticketRuns(id), queryFn: () => api.ticketRuns(id) }),
  sessions: (active = false) => queryOptions({ queryKey: qk.sessions(active), queryFn: () => api.sessions(active) }),
  session: (id: string) => queryOptions({ queryKey: qk.session(id), queryFn: () => api.session(id) }),
  approvals: (pending = false) => queryOptions({ queryKey: qk.approvals(pending), queryFn: () => api.approvals(pending) }),
  activity: () => queryOptions({ queryKey: qk.activity, queryFn: () => api.activity(150) }),
  runs: (status?: string) => queryOptions({ queryKey: qk.runs(status), queryFn: () => api.runs(status) }),
  run: (id: string) => queryOptions({ queryKey: qk.run(id), queryFn: () => api.run(id) }),
  workflows: () => queryOptions({ queryKey: qk.workflows, queryFn: api.workflows }),
  workflow: (id: string) => queryOptions({ queryKey: qk.workflow(id), queryFn: () => api.workflow(id) }),
  sources: () => queryOptions({ queryKey: qk.sources, queryFn: api.sources, staleTime: Infinity }),
  sourceConnections: () => queryOptions({ queryKey: qk.sourceConnections, queryFn: api.sourceConnections })
}

type Sessions = ReadonlyArray<AgentSession>

/**
 * Put a pushed session into every cached list it belongs to. Lists are newest first, so a
 * new session goes on top; a snapshot older than the cached one (fewer events) is ignored.
 */
export const upsertSession = (session: AgentSession) => {
  const live = LIVE_SESSION_STATES.includes(session.state)
  const merge = (keep: boolean) => (list: Sessions | undefined): Sessions | undefined => {
    if (!list) return list
    const i = list.findIndex((s) => s.id === session.id)
    if (i === -1) return keep ? [session, ...list] : list
    if (list[i]!.lastEventId > session.lastEventId) return list
    if (!keep) return list.filter((s) => s.id !== session.id)
    const next = [...list]
    next[i] = session
    return next
  }
  queryClient.setQueryData<Sessions>(qk.sessions(false), merge(true))
  queryClient.setQueryData<Sessions>(qk.sessions(true), merge(live))
  queryClient.setQueryData<Sessions>(qk.ticketSessions(session.ticketId), merge(true))
  queryClient.setQueryData<AgentSession>(qk.session(session.id), (old) =>
    old && old.lastEventId > session.lastEventId ? old : session
  )
}

/** Map daemon change notices to cache updates (pushed sessions) or query invalidations. */
export const applyNotice = (n: ChangeNotice) => {
  const inv = (key: ReadonlyArray<unknown>) => void queryClient.invalidateQueries({ queryKey: key })
  switch (n.topic) {
    case "settings":
      inv(qk.harnessSettings)
      break
    case "tickets":
      if (!n.ticketId) {
        inv(["tickets"])
        break
      }
      // A ticket change touches lists, the ticket and its worktree. Its sessions, approvals,
      // activity and runs have their own notices: invalidating the whole ["tickets"] prefix
      // would refetch them on every session state change.
      inv(["tickets", "list"])
      void queryClient.invalidateQueries({ queryKey: qk.ticket(n.ticketId), exact: true })
      inv(qk.ticketDiff(n.ticketId))
      inv(qk.ticketWorkspace(n.ticketId))
      inv(qk.ticketFiles(n.ticketId))
      break
    case "projects":
      inv(qk.projects)
      break
    case "sessions":
      if (n.session) {
        upsertSession(n.session)
        break
      }
      inv(["sessions"])
      if (n.ticketId) inv(qk.ticketSessions(n.ticketId))
      if (n.sessionId) inv(qk.session(n.sessionId))
      break
    case "approvals":
      inv(["approvals"])
      inv(["runs"])
      if (n.ticketId) inv(qk.ticketApprovals(n.ticketId))
      inv(["tickets", "list"])
      break
    case "activity":
      inv(qk.activity)
      if (n.ticketId) inv(qk.ticketActivity(n.ticketId))
      break
    case "runs":
      inv(["runs"])
      if (n.runId) inv(qk.run(n.runId))
      if (n.ticketId) inv(qk.ticketRuns(n.ticketId))
      inv(["tickets"])
      break
    case "workflows":
      inv(qk.workflows)
      break
    case "sources":
      inv(qk.sourceConnections)
      inv(["tickets"])
      break
  }
}
