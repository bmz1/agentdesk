import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-bg-muted text-fg-muted",
        accent: "bg-accent/15 text-accent",
        success: "bg-success/15 text-success",
        warning: "bg-warning/15 text-warning",
        danger: "bg-danger/15 text-danger",
        info: "bg-info/15 text-info",
        outline: "border text-fg-muted"
      }
    },
    defaultVariants: { tone: "neutral" }
  }
)

export const Badge = ({ className, tone, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) => (
  <span className={cn(badgeVariants({ tone }), className)} {...props} />
)
