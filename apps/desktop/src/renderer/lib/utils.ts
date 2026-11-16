import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export const cn = (...inputs: Array<ClassValue>) => twMerge(clsx(inputs))

export const relativeTime = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return "—"
  const diff = Math.round((now - new Date(iso).getTime()) / 1000)
  if (diff < 45) return "just now"
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86_400) return `${Math.round(diff / 3600)}h ago`
  if (diff < 86_400 * 30) return `${Math.round(diff / 86_400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
