import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Command } from "cmdk"
import { BellRing, Bot, FolderGit2, Inbox, LayoutGrid, MessageSquarePlus, PanelLeft, Plus, Settings, Workflow } from "lucide-react"
import { Dialog as D } from "radix-ui"
import { useState } from "react"
import { StatusIcon } from "@/components/status"
import { type ShortcutId, shortcutHint } from "@/lib/keymap"
import { q } from "@/lib/queries"
import { useUi } from "@/lib/store"
import { useJumpToAttention } from "./global-shortcuts"

export const CommandPalette = () => {
  const open = useUi((s) => s.commandOpen)
  const setOpen = useUi((s) => s.setCommandOpen)
  const openCreate = useUi((s) => s.openCreateTicket)
  const navigate = useNavigate()
  const jump = useJumpToAttention()
  const [search, setSearch] = useState("")
  const tickets = useQuery({ ...q.tickets({ q: search.trim() || undefined }), enabled: open })
  const projects = useQuery({ ...q.projects(), enabled: open })


  const go = (fn: () => void) => {
    setOpen(false)
    setSearch("")
    fn()
  }

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <D.Content className="fixed left-1/2 top-[15%] z-50 w-[620px] max-w-[92vw] -translate-x-1/2 overflow-hidden rounded-lg border bg-bg-elevated shadow-2xl">
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">Search tickets and run commands</D.Description>
          <Command shouldFilter={false} className="flex flex-col">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Search tickets or type a command…"
              className="h-11 border-b bg-transparent px-4 text-sm outline-none placeholder:text-fg-subtle"
            />
            <Command.List className="max-h-[400px] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-fg-subtle">
              <Command.Empty className="px-3 py-6 text-center text-xs text-fg-subtle">No results</Command.Empty>
              {!search && (
                <Command.Group heading="Actions">
                  <Item onSelect={() => go(() => openCreate(undefined, "thread"))} icon={<MessageSquarePlus />} shortcut="newThread">
                    New thread
                  </Item>
                  <Item onSelect={() => go(() => openCreate())} icon={<Plus />} shortcut="newTicket">
                    Create local ticket
                  </Item>
                  <Item onSelect={() => go(() => void jump())} icon={<BellRing />} shortcut="nextAttention">
                    Next agent that needs you
                  </Item>
                  <Item onSelect={() => go(() => navigate({ to: "/inbox" }))} icon={<Inbox />} shortcut="goInbox">
                    Go to Inbox
                  </Item>
                  <Item onSelect={() => go(() => navigate({ to: "/issues" }))} icon={<LayoutGrid />} shortcut="goIssues">
                    Go to All issues
                  </Item>
                  <Item onSelect={() => go(() => navigate({ to: "/agents" }))} icon={<Bot />} shortcut="goAgents">
                    Go to My agents' work
                  </Item>
                  <Item onSelect={() => go(() => navigate({ to: "/workflows" }))} icon={<Workflow />} shortcut="goWorkflows">
                    Go to Workflows
                  </Item>
                  <Item onSelect={() => go(() => navigate({ to: "/projects" }))} icon={<FolderGit2 />} shortcut="goProjects">
                    Go to Projects
                  </Item>
                  <Item onSelect={() => go(() => navigate({ to: "/settings" }))} icon={<Settings />} shortcut="goSettings">
                    Go to Settings
                  </Item>
                  <Item onSelect={() => go(() => useUi.getState().toggleSidebar())} icon={<PanelLeft />} shortcut="toggleSidebar">
                    Toggle sidebar
                  </Item>
                </Command.Group>
              )}
              {(tickets.data?.length ?? 0) > 0 && (
                <Command.Group heading="Tickets">
                  {tickets.data!.slice(0, 30).map((t) => (
                    <Item
                      key={t.id}
                      value={t.id}
                      onSelect={() => go(() => navigate({ to: "/issues/$ticketId", params: { ticketId: t.id } }))}
                      icon={<StatusIcon status={t.status} />}
                    >
                      <span className="w-20 shrink-0 font-mono text-[11px] text-fg-subtle">{t.identifier}</span>
                      <span className="truncate">{t.title}</span>
                    </Item>
                  ))}
                </Command.Group>
              )}
              {!search && (projects.data?.length ?? 0) > 0 && (
                <Command.Group heading="Projects">
                  {projects.data!.map((p) => (
                    <Item
                      key={p.id}
                      value={`project-${p.id}`}
                      onSelect={() => go(() => navigate({ to: "/projects/$projectId", params: { projectId: p.id } }))}
                      icon={<FolderGit2 />}
                    >
                      {p.name}
                    </Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

const Item = ({ children, icon, onSelect, value, shortcut }: {
  children: React.ReactNode
  icon: React.ReactNode
  onSelect: () => void
  value?: string
  shortcut?: ShortcutId
}) => (
  <Command.Item
    value={value ?? String(children)}
    onSelect={onSelect}
    className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] data-[selected=true]:bg-bg-muted [&_svg]:size-3.5 [&_svg]:text-fg-muted"
  >
    {icon}
    {children}
    {shortcut && <kbd className="ml-auto font-sans text-[11px] text-fg-subtle">{shortcutHint(shortcut)}</kbd>}
  </Command.Item>
)
