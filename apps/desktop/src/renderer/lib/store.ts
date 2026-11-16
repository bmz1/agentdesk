import { create } from "zustand"
import { persist } from "zustand/middleware"

/** Transient/local UI state only. Server state lives in TanStack Query; filters live in the URL. */
interface UiState {
  sidebarCollapsed: boolean
  theme: "dark" | "light" | "system"
  commandOpen: boolean
  createTicketOpen: boolean
  createTicketProjectId: string | undefined
  daemonConnected: boolean
  lastRoute: string | undefined
  toggleSidebar(): void
  setTheme(t: UiState["theme"]): void
  setCommandOpen(open: boolean): void
  openCreateTicket(projectId?: string): void
  closeCreateTicket(): void
  setDaemonConnected(c: boolean): void
  setLastRoute(r: string): void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: "dark",
      commandOpen: false,
      createTicketOpen: false,
      createTicketProjectId: undefined,
      daemonConnected: false,
      lastRoute: undefined,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      openCreateTicket: (projectId) => set({ createTicketOpen: true, createTicketProjectId: projectId }),
      closeCreateTicket: () => set({ createTicketOpen: false }),
      setDaemonConnected: (daemonConnected) => set({ daemonConnected }),
      setLastRoute: (lastRoute) => set({ lastRoute })
    }),
    {
      name: "agentdesk.ui",
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, theme: s.theme, lastRoute: s.lastRoute })
    }
  )
)
