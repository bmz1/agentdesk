import { QueryClientProvider } from "@tanstack/react-query"
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { TooltipProvider } from "./components/ui/misc"
import { Toaster } from "./components/ui/toaster"
import { DaemonGate } from "./features/shell/daemon-gate"
import { queryClient } from "./lib/queries"
import { routeTree } from "./routeTree.gen"
import "./styles.css"

// Hash history works for both file:// (packaged Electron) and the dev server.
const router = createRouter({
  routeTree,
  history: createHashHistory(),
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <DaemonGate>
          <RouterProvider router={router} />
        </DaemonGate>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>
)
