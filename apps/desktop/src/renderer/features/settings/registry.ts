import type { LucideIcon } from "lucide-react"
import { ListTodo } from "lucide-react"
import type { ComponentType } from "react"
import { SourcesSettings } from "./sources-settings"

/** Settings sections contributed by optional features, each a view of its own in the settings nav. */
export const settingsSections: Array<{ id: string; label: string; icon: LucideIcon; component: ComponentType }> = [
  { id: "sources", label: "Task sources", icon: ListTodo, component: SourcesSettings }
]
