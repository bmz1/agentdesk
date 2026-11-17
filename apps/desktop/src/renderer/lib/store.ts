import { create } from "zustand"
import { persist } from "zustand/middleware"
import { READ_BASELINE_KEY } from "./agent-state"

export interface ViewPreferences {
  view?: "board" | "list"
  q?: string
  project?: string
  source?: string
  harness?: string
  attention?: boolean
}

export interface ReviewComment {
  id: string
  path: string
  side: "old" | "new"
  line: number
  code: string
  text: string
  resolved: boolean
  sentAt?: string
}

/** Local preferences and drafts only; server state lives in TanStack Query. */
interface UiState {
  views: Record<string, ViewPreferences>
  setView(key: string, value: ViewPreferences): void
  sessionSeen: Record<string, number>
  markSessionRead(id: string, eventId: number): void
  markSessionUnread(id: string): void
  ticketLayouts: Record<string, { split: boolean; width: number }>
  setTicketLayout(id: string, layout: { split: boolean; width: number }): void
  reviewComments: Record<string, Array<ReviewComment>>
  setReviewComments(id: string, comments: Array<ReviewComment>): void
  sidebarCollapsed: boolean
  /** Projects whose thread list is folded in the sidebar. */
  collapsedProjects: Record<string, boolean>
  toggleProject(id: string): void
  theme: "dark" | "light" | "system"
  commandOpen: boolean
  createTicketOpen: boolean
  createTicketProjectId: string | undefined
  /** Which form the create dialog opens with: a quick thread (default) or a full ticket. */
  createKind: "thread" | "ticket"
  daemonConnected: boolean
  lastRoute: string | undefined
  toggleSidebar(): void
  setTheme(t: UiState["theme"]): void
  setCommandOpen(open: boolean): void
  openCreateTicket(projectId?: string, kind?: "thread" | "ticket"): void
  closeCreateTicket(): void
  setDaemonConnected(c: boolean): void
  setLastRoute(r: string): void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      views: {},
      setView: (key, value) => set((s) => ({ views: { ...s.views, [key]: value } })),
      sessionSeen: {},
      markSessionRead: (id, eventId) => set((s) => ({ sessionSeen: { ...s.sessionSeen, [id]: Math.max(s.sessionSeen[id] ?? 0, eventId) } })),
      markSessionUnread: (id) => set((s) => ({ sessionSeen: { ...s.sessionSeen, [id]: -1 } })),
      ticketLayouts: {},
      setTicketLayout: (id, layout) => set((s) => ({ ticketLayouts: { ...s.ticketLayouts, [id]: layout } })),
      reviewComments: {},
      setReviewComments: (id, comments) => set((s) => ({ reviewComments: { ...s.reviewComments, [id]: comments } })),
      sidebarCollapsed: false,
      collapsedProjects: {},
      toggleProject: (id) => set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [id]: !s.collapsedProjects[id] } })),
      theme: "dark",
      commandOpen: false,
      createTicketOpen: false,
      createTicketProjectId: undefined,
      createKind: "thread",
      daemonConnected: false,
      lastRoute: undefined,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      openCreateTicket: (projectId, kind = "ticket") => set({ createTicketOpen: true, createTicketProjectId: projectId, createKind: kind }),
      closeCreateTicket: () => set({ createTicketOpen: false }),
      setDaemonConnected: (daemonConnected) => set({ daemonConnected }),
      setLastRoute: (lastRoute) => set({ lastRoute })
    }),
    {
      name: "agentdesk.ui",
      version: 1,
      // v0 lists reported no event ids, so nothing ever looked unread. Treat everything that
      // finished before the upgrade as read instead of flagging the whole history at once.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<UiState>
        if (version < 1) state.sessionSeen = { ...state.sessionSeen, [READ_BASELINE_KEY]: Date.now() }
        return state as UiState
      },
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, collapsedProjects: s.collapsedProjects, theme: s.theme, lastRoute: s.lastRoute, views: s.views, sessionSeen: s.sessionSeen, ticketLayouts: s.ticketLayouts, reviewComments: s.reviewComments })
    }
  )
)
