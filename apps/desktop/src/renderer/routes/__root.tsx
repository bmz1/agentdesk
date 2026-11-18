import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Outlet, useLocation, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef } from "react"
import { CommandPalette } from "@/features/shell/command-palette"
import { CreateTicketDialog } from "@/features/shell/create-ticket-dialog"
import { GlobalShortcuts } from "@/features/shell/global-shortcuts"
import { DaemonOfflineBanner } from "@/features/shell/daemon-offline-banner"
import { Sidebar } from "@/features/shell/sidebar"
import { UpdateNotifier } from "@/features/updates/update-notifier"
import { useUi } from "@/lib/store"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout
})

function RootLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const setLastRoute = useUi((s) => s.setLastRoute)
  const restored = useRef(false)

  // Restore the last visited route (and its search params) after reopening the app.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    const last = useUi.getState().lastRoute
    if ((location.pathname === "/" || location.pathname === "") && last && last !== "/") {
      void navigate({ href: last, replace: true })
    }
  }, [location.pathname, navigate])

  useEffect(() => {
    if (location.pathname !== "/") setLastRoute(location.href)
  }, [location.href, location.pathname, setLastRoute])

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <DaemonOfflineBanner />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
      <GlobalShortcuts />
      <CommandPalette />
      <CreateTicketDialog />
      <UpdateNotifier />
    </div>
  )
}
