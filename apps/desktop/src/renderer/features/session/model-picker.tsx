import type { HarnessId, HarnessModel, PermissionMode, Project } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { PERMISSION_MODES } from "@/features/projects/project-form"
import { q } from "@/lib/queries"
import { cn } from "@/lib/utils"

// Same bounded chevron as the form selects (`select-control`), compact and borderless for the composer.
const pickerClass =
  "select-control h-6 min-w-0 truncate rounded border-0 bg-transparent pl-1 pr-6 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
const noNativeArrow = { appearance: "none", WebkitAppearance: "none" } as const

/** Effort levels for a model: harness-wide (Claude) or advertised per model (Codex). */
export const effortsFor = (harnessEfforts: ReadonlyArray<string> | undefined, models: ReadonlyArray<HarnessModel>, model: string | null | undefined) => {
  if (harnessEfforts?.length) return { levels: harnessEfforts, defaultLevel: undefined }
  const m = (model && models.find((x) => x.id === model)) || models.find((x) => x.efforts?.length)
  return { levels: m?.efforts ?? [], defaultLevel: m?.defaultEffort }
}

/**
 * What a harness offers for a chosen model: its models, the effort levels of that model, and the
 * defaults that apply when nothing is chosen. Selected values the harness no longer lists are kept.
 */
export const useHarnessOptions = (harness: HarnessId | undefined, model: string | null, effort: string | null) => {
  const detections = useQuery(q.harnesses())
  const settings = useQuery(q.harnessSettings())
  const detection = harness ? detections.data?.find((d) => d.id === harness) : undefined
  const listed = detection?.models ?? []
  const defaults = harness ? settings.data?.harnesses[harness] : undefined
  const { levels, defaultLevel } = effortsFor(detection?.efforts, listed, model ?? defaults?.model)
  return {
    detection,
    defaults,
    models: model && !listed.some((m) => m.id === model) ? [...listed, { id: model, label: model, provider: undefined }] : listed,
    levels: effort && !levels.includes(effort) ? [...levels, effort] : levels,
    // The configured default, else what the harness itself defaults to.
    defaultModel: (defaults?.model && (listed.find((m) => m.id === defaults.model)?.label ?? defaults.model)) || detection?.defaultModel,
    defaultLevel
  }
}

/** The permission mode a ticket without its own choice runs with. */
export const usePermissionDefault = (project: Project | undefined, harness: HarnessId | undefined): PermissionMode | undefined => {
  const settings = useQuery(q.harnessSettings())
  if (!project) return undefined
  if (!project.inheritHarnessPermissions) return project.permissionMode
  return (harness && settings.data?.harnesses[harness]?.permissionMode) || "ask"
}

export const permissionLabel = (mode: PermissionMode | undefined, short = false) => {
  const m = PERMISSION_MODES.find((x) => x.id === mode)
  return m ? (short ? m.short : m.label) : undefined
}

export const modelLabel = (m: HarnessModel) => (m.provider ? `${m.provider} / ${m.label}` : m.label)

/**
 * Compact model and effort switches for the composer. The session's harness is fixed; changes apply
 * from the next message on. null means the default.
 */
export const ComposerModelPicker = ({
  harness,
  model,
  effort,
  onModel,
  onEffort,
  disabled
}: {
  harness: HarnessId
  model: string | null
  effort: string | null
  onModel: (model: string | null) => void
  onEffort: (effort: string | null) => void
  disabled?: boolean
}) => {
  const { models, levels, defaultModel, defaultLevel } = useHarnessOptions(harness, model, effort)
  return (
    <>
      {models.length > 0 && (
        <select
          aria-label="Model for the next message"
          title="Model for the next message (stays selected for this ticket)"
          value={model ?? ""}
          disabled={disabled}
          onChange={(e) => onModel(e.target.value || null)}
          className={cn(pickerClass, "max-w-44")}
          style={noNativeArrow}
          data-testid="composer-model"
        >
          <option value="">{defaultModel ? `Default · ${defaultModel}` : "Default model"}</option>
          {models.map((m) => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
        </select>
      )}
      {levels.length > 0 && (
        <select
          aria-label="Reasoning effort for the next message"
          title="Reasoning effort for the next message (stays selected for this ticket)"
          value={effort ?? ""}
          disabled={disabled}
          onChange={(e) => onEffort(e.target.value || null)}
          className={cn(pickerClass, "max-w-28")}
          style={noNativeArrow}
          data-testid="composer-effort"
        >
          <option value="">{defaultLevel ? `Effort · ${defaultLevel}` : "Default effort"}</option>
          {levels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      )}
    </>
  )
}

/** Permission mode switch for the composer. A change restarts the agent on the same conversation. */
export const ComposerPermissionPicker = ({
  value,
  projectDefault,
  onChange,
  disabled
}: {
  value: PermissionMode | null
  projectDefault: PermissionMode | undefined
  onChange: (mode: PermissionMode | null) => void
  disabled?: boolean
}) => (
  <select
    aria-label="Permission mode for the next message"
    title="Permission mode from the next message on (the agent restarts on the same conversation; stays selected for this ticket)"
    value={value ?? ""}
    disabled={disabled}
    onChange={(e) => onChange((e.target.value || null) as PermissionMode | null)}
    className={cn(pickerClass, "max-w-40")}
    style={noNativeArrow}
    data-testid="composer-permission"
  >
    <option value="">{projectDefault ? `Default · ${permissionLabel(projectDefault, true)}` : "Default permissions"}</option>
    {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.short}</option>)}
  </select>
)
