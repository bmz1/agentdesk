import type { LucideIcon } from "lucide-react"
import { Download, ListTodo } from "lucide-react"
import type { ComponentType } from "react"
import { UpdateSettings } from "../updates/update-settings"
import { SourcesSettings } from "./sources-settings"

/** Settings sections contributed by optional features, each a view of its own in the settings nav. */
export const settingsSections: Array<{ id: string; label: string; icon: LucideIcon; component: ComponentType }> = [
  { id: "sources", label: "Task sources", icon: ListTodo, component: SourcesSettings },
  { id: "updates", label: "Updates", icon: Download, component: UpdateSettings }
]
