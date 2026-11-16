import * as React from "react"
import { cn } from "@/lib/utils"

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-7 w-full rounded-md border bg-bg px-2 text-[13px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
)
Input.displayName = "Input"

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none rounded-md border bg-bg px-2 py-1.5 text-[13px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
        className
      )}
      {...props}
    />
  )
)
Textarea.displayName = "Textarea"

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-7 rounded-md border bg-bg px-1.5 text-[13px] text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
        className
      )}
      {...props}
    />
  )
)
Select.displayName = "Select"

export const Label = ({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
  <label className={cn("text-xs font-medium text-fg-muted", className)} {...props} />
)

export const Field = ({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1">
    <Label>{label}</Label>
    {children}
    {hint && <p className="text-[11px] text-fg-subtle">{hint}</p>}
  </div>
)
