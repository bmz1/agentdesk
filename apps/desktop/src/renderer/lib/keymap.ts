import { useEffect, useRef } from "react"

/**
 * One table of keyboard shortcuts. Global handlers, the command palette's hints and tooltips
 * all read from it, so a binding is defined (and later rebound) in exactly one place.
 * `mod` is ⌘ on macOS and Ctrl elsewhere. No prefix keys: every shortcut is one chord.
 */
export const SHORTCUTS = {
  palette: { keys: "mod+k", label: "Command palette" },
  newThread: { keys: "mod+n", label: "New thread" },
  newTicket: { keys: "c", label: "Create local ticket" },
  nextAttention: { keys: "mod+j", label: "Next agent that needs you" },
  goInbox: { keys: "mod+1", label: "Go to Inbox" },
  goIssues: { keys: "mod+2", label: "Go to All issues" },
  goAgents: { keys: "mod+3", label: "Go to My agents' work" },
  goWorkflows: { keys: "mod+4", label: "Go to Workflows" },
  goProjects: { keys: "mod+5", label: "Go to Projects" },
  goSettings: { keys: "mod+,", label: "Go to Settings" },
  toggleSidebar: { keys: "mod+b", label: "Toggle sidebar" },
  approve: { keys: "mod+shift+a", label: "Allow pending tool call" },
  deny: { keys: "mod+shift+d", label: "Deny pending tool call" },
  interrupt: { keys: "mod+.", label: "Interrupt agent" }
} as const satisfies Record<string, { keys: string; label: string }>

export type ShortcutId = keyof typeof SHORTCUTS

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

interface Chord {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}

export const parseChord = (keys: string): Chord => {
  const parts = keys.toLowerCase().split("+")
  // "mod++" would split into an empty key; keep the last token as the key.
  const key = parts.at(-1) || "+"
  return { mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt"), key }
}

/** Whether a keydown event is exactly this chord (extra modifiers don't match). */
export const matchesChord = (
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  keys: string,
  mac = isMac()
) => {
  const chord = parseChord(keys)
  const mod = mac ? e.metaKey : e.ctrlKey
  const other = mac ? e.ctrlKey : e.metaKey
  return (
    mod === chord.mod && !other && e.shiftKey === chord.shift && e.altKey === chord.alt && e.key.toLowerCase() === chord.key
  )
}

/** Human label for a chord: "⌘⇧A" on macOS, "Ctrl+Shift+A" elsewhere. */
export const formatChord = (keys: string, mac = isMac()) => {
  const chord = parseChord(keys)
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : chord.key[0]!.toUpperCase() + chord.key.slice(1)
  if (mac) return `${chord.mod ? "⌘" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${key}`
  return [chord.mod && "Ctrl", chord.alt && "Alt", chord.shift && "Shift", key].filter(Boolean).join("+")
}

export const shortcutHint = (id: ShortcutId) => formatChord(SHORTCUTS[id].keys)

export const isTypingTarget = (target: EventTarget | null) => {
  const t = target as HTMLElement | null
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
}

/**
 * Run `handler` when the shortcut fires. Chords without a modifier are ignored while typing;
 * chords with one work everywhere, including the composer.
 */
export const useShortcut = (id: ShortcutId, handler: (e: KeyboardEvent) => void, enabled = true) => {
  const latest = useRef(handler)
  latest.current = handler
  useEffect(() => {
    if (!enabled) return
    const keys = SHORTCUTS[id].keys
    const bare = !parseChord(keys).mod
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !matchesChord(e, keys)) return
      if (bare && isTypingTarget(e.target)) return
      e.preventDefault()
      latest.current(e)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [id, enabled])
}
