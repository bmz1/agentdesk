import { useEffect } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { shortcutHint } from "@/lib/keymap"
import {
  Bot,
  ChevronDown,
  ChevronsLeft,
  FolderGit2,
  Inbox,
  LayoutGrid,
  Plus,
  Search,
  Settings,
  Target,
  Workflow
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd, Tooltip } from "@/components/ui/misc"
import { notificationCount } from "@/lib/agent-state"
import { bridge } from "@/lib/connection"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ProjectThreads, useProjectThreads } from "./project-threads"
import { UsageLimits } from "./usage-limits"

const isMac = window.agentdesk?.platform === "darwin"

const navItem =
  "flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted hover:bg-bg-muted hover:text-fg [&_svg]:size-3.5 [&_svg]:shrink-0"
const active = { className: "bg-bg-muted !text-fg font-medium" }

export const Sidebar = () => {
  const collapsed = useUi((s) => s.sidebarCollapsed)
  const toggle = useUi((s) => s.toggleSidebar)
  const openCreate = useUi((s) => s.openCreateTicket)
  const setCommandOpen = useUi((s) => s.setCommandOpen)
  const projects = useQuery(q.projects())
  const pending = useQuery(q.approvals(true))
  const activeSessions = useQuery(q.sessions(true))
  const connected = useUi((s) => s.daemonConnected)
  const info = useQuery(q.info())
  const threads = useProjectThreads()
  const seen = useUi((s) => s.sessionSeen)
  const inboxSessions = [...threads.values()].flat().map((t) => t.session)
  const inboxCount = notificationCount(inboxSessions, pending.data ?? [], seen)
  useEffect(() => {
    if (pending.isPending) return
    void bridge()?.updateNotificationState?.(inboxCount, seen).catch(() => {})
  }, [inboxCount, seen, pending.isPending])
  const collapsedProjects = useUi((s) => s.collapsedProjects)
  const toggleProject = useUi((s) => s.toggleProject)

  if (collapsed) {
    return (
      <div className="flex w-12 flex-col items-center gap-1 border-r bg-bg-subtle pt-10">
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Expand sidebar">
          <ChevronsLeft className="rotate-180" />
        </Button>
        <Link to="/inbox" className={cn(navItem, "w-8 justify-center px-0")} activeProps={active}>
          <Inbox />
        </Link>
        <Link to="/issues" className={cn(navItem, "w-8 justify-center px-0")} activeProps={active}>
          <LayoutGrid />
        </Link>
        <Link to="/agents" className={cn(navItem, "w-8 justify-center px-0")} activeProps={active}>
          <Bot />
        </Link>
      </div>
    )
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-bg-subtle">
      <div className={cn("drag-region flex h-11 items-center justify-between pr-2", isMac ? "pl-20" : "pl-3")}>
        <span className="no-drag text-[13px] font-semibold tracking-tight">AgentDesk</span>
        <div className="no-drag flex gap-0.5">
          <Button variant="ghost" size="icon" onClick={() => setCommandOpen(true)} aria-label="Search">
            <Search />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => openCreate(undefined, "thread")} aria-label={`New thread (${shortcutHint("newThread")})`} title={`New thread (${shortcutHint("newThread")})`} data-testid="new-ticket">
            <Plus />
          </Button>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        <Link to="/inbox" className={navItem} activeProps={active}>
          <Inbox /> Inbox
          {inboxCount > 0 && (
            <span className="ml-auto rounded bg-warning/20 px-1.5 text-[11px] font-medium text-warning">{inboxCount}</span>
          )}
        </Link>
        <Link to="/my-issues" className={navItem} activeProps={active}>
          <Target /> My issues
        </Link>
        <Link to="/agents" className={navItem} activeProps={active}>
          <Bot /> Agents
          {(activeSessions.data?.length ?? 0) > 0 && (
            <span className="ml-auto rounded bg-accent/20 px-1.5 text-[11px] font-medium text-accent">{activeSessions.data!.length}</span>
          )}
        </Link>
        <Link to="/issues" className={navItem} activeProps={active} activeOptions={{ includeSearch: false }}>
          <LayoutGrid /> All issues
        </Link>

        <div className="mt-4 flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] font-medium text-fg-subtle">Projects</span>
          <Link to="/projects" className="text-fg-subtle hover:text-fg" aria-label="Manage projects">
            <Plus className="size-3.5" />
          </Link>
        </div>
        {(projects.data ?? []).map((p) => {
          const projectThreads = threads.get(p.id) ?? []
          const folded = !!collapsedProjects[p.id]
          return (
            <div key={p.id}>
              <div className="group flex items-center">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: p.id }}
                  className={cn(navItem, "min-w-0 flex-1")}
                  activeProps={active}
                  data-testid="sidebar-project"
                >
                  <FolderGit2 />
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-fg-subtle">{p.key}</span>
                </Link>
                <button
                  type="button"
                  onClick={() => openCreate(p.id, "thread")}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-bg-muted hover:text-fg"
                  aria-label={`New thread in ${p.name}`}
                  title="New thread / ticket"
                  data-testid="project-new-thread"
                >
                  <Plus className="size-3.5" />
                </button>
                {projectThreads.length > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleProject(p.id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-bg-muted hover:text-fg"
                    aria-label={folded ? `Show ${p.name} threads` : `Hide ${p.name} threads`}
                    title={folded ? "Show threads" : "Hide threads"}
                  >
                    <ChevronDown className={cn("size-3.5 transition-transform", folded && "-rotate-90")} />
                  </button>
                )}
              </div>
              {!folded && <ProjectThreads threads={projectThreads} />}
            </div>
          )
        })}
        {projects.data?.length === 0 && (
          <Link to="/projects" className="px-2 text-xs text-accent hover:underline">
            Add your first project
          </Link>
        )}

        <div className="mt-4" />
        <Link to="/workflows" className={navItem} activeProps={active}>
          <Workflow /> Workflows
        </Link>
        <Link to="/settings" className={navItem} activeProps={active}>
          <Settings /> Settings
        </Link>
      </nav>
      <div className="border-t px-3 py-2 text-[11px] text-fg-subtle">
        <UsageLimits />
        <div className="flex items-center gap-1.5">
          <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-danger")} />
          {connected ? "Daemon connected" : "Daemon offline"}
          <span className="ml-auto">
            <Kbd>{shortcutHint("palette")}</Kbd>
          </span>
        </div>
        {info.data && !info.data.persistent && (
          <Tooltip content="The daemon runs as a background process, not a login service. Agent work continues when this window closes, but stops if the daemon is killed, you log out or reboot. Install the launch agent from Settings for persistence.">
            <div className="mt-1 cursor-help text-warning">Background daemon · not persistent</div>
          </Tooltip>
        )}
      </div>
    </aside>
  )
}
