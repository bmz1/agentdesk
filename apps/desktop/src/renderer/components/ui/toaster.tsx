import type * as React from "react"
import { Toaster as Sonner } from "sonner"
import { useUi } from "@/lib/store"

// Sonner reads these variables; mapping them onto our tokens keeps toasts on-palette in both themes.
const palette = {
  "--normal-bg": "var(--bg-elevated)",
  "--normal-text": "var(--fg)",
  "--normal-border": "var(--border)",
  "--error-bg": "var(--bg-elevated)",
  "--error-text": "var(--danger)",
  "--error-border": "var(--border)"
} as React.CSSProperties

export const Toaster = () => {
  const theme = useUi((s) => s.theme)
  return <Sonner theme={theme} position="bottom-right" style={palette} toastOptions={{ className: "text-[13px]" }} />
}
