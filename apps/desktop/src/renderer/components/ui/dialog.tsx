import { X } from "lucide-react"
import { Dialog as D } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

export const DialogContent = ({
  className,
  children,
  title,
  description,
  ...props
}: React.ComponentProps<typeof D.Content> & { title: string; description?: string }) => (
  <D.Portal>
    <D.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]" />
    <D.Content
      className={cn(
        "fixed left-1/2 top-[12%] z-50 w-[560px] max-w-[92vw] -translate-x-1/2 rounded-lg border bg-bg-elevated shadow-2xl focus:outline-none",
        className
      )}
      {...props}
    >
      <div className="flex items-start justify-between border-b px-4 py-3">
        <div>
          <D.Title className="text-sm font-semibold">{title}</D.Title>
          {description ? (
            <D.Description className="mt-0.5 text-xs text-fg-muted">{description}</D.Description>
          ) : (
            <D.Description className="sr-only">{title}</D.Description>
          )}
        </div>
        <D.Close className="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-fg" aria-label="Close">
          <X className="size-4" />
        </D.Close>
      </div>
      {children}
    </D.Content>
  </D.Portal>
)
