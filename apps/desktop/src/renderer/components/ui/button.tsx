import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"
import * as React from "react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:bg-accent/90",
        secondary: "border bg-bg-elevated text-fg hover:bg-bg-muted",
        ghost: "text-fg-muted hover:bg-bg-muted hover:text-fg",
        danger: "bg-danger text-white hover:bg-danger/90",
        success: "bg-success text-white hover:bg-success/90",
        link: "text-accent underline-offset-4 hover:underline"
      },
      size: {
        sm: "h-6 px-2 text-xs",
        default: "h-7 px-2.5 text-[13px]",
        lg: "h-9 px-4 text-sm",
        icon: "size-7"
      }
    },
    defaultVariants: { variant: "default", size: "default" }
  }
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot.Root : "button"
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})
Button.displayName = "Button"
