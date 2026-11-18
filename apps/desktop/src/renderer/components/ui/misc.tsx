import { Loader2 } from "lucide-react"
import { Tabs as T, Tooltip as Tip } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cn("size-3.5 animate-spin", className)} />

export const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded border bg-bg-muted px-1 font-mono text-[10px] text-fg-muted">{children}</kbd>
)

export const EmptyState = ({
  icon,
  title,
  children,
  action
}: {
  icon?: React.ReactNode
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) => (
  <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
    {icon && <div className="text-fg-subtle [&_svg]:size-8">{icon}</div>}
    <div className="text-sm font-medium">{title}</div>
    {children && <div className="max-w-sm text-xs text-fg-muted">{children}</div>}
    {action && <div className="mt-2">{action}</div>}
  </div>
)

/**
 * Mounted once at the app root. A single provider lets Radix skip the open delay when the
 * pointer moves from one tooltip to the next; per-tooltip providers each waited 300ms.
 */
export const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <Tip.Provider delayDuration={300} skipDelayDuration={300}>
    {children}
  </Tip.Provider>
)

export const Tooltip = ({ content, children }: { content: React.ReactNode; children: React.ReactNode }) => (
  <Tip.Root>
    <Tip.Trigger asChild>{children}</Tip.Trigger>
    <Tip.Portal>
      <Tip.Content sideOffset={4} className="tooltip-motion z-50 rounded border bg-bg-elevated px-2 py-1 text-[11px] text-fg shadow-lg">
        {content}
      </Tip.Content>
    </Tip.Portal>
  </Tip.Root>
)

export const Tabs = T.Root
export const TabsList = ({ className, ...p }: React.ComponentProps<typeof T.List>) => (
  <T.List className={cn("flex items-center gap-1 border-b px-4", className)} {...p} />
)
export const TabsTrigger = ({ className, ...p }: React.ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      "relative -mb-px flex h-9 items-center gap-1.5 rounded-t border-b-2 border-transparent px-2 text-[13px] text-fg-muted outline-none hover:text-fg focus-visible:ring-1 focus-visible:ring-accent/50 data-[state=active]:border-accent data-[state=active]:text-fg [&_svg]:size-3.5",
      className
    )}
    {...p}
  />
)
export const TabsContent = T.Content

export const Section = ({
  title,
  actions,
  children,
  className
}: {
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) => (
  <section className={cn("rounded-lg border bg-bg-subtle", className)}>
    <header className="flex items-center justify-between border-b px-3 py-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h3>
      {actions}
    </header>
    <div className="p-3">{children}</div>
  </section>
)
