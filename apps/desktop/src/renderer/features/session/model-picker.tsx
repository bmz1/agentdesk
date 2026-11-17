import type { HarnessId, HarnessModel } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { q } from "@/lib/queries"
import { cn } from "@/lib/utils"

const pickerClass =
  "h-6 min-w-0 truncate rounded border-0 bg-transparent px-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"

/** Effort levels for a model: harness-wide (Claude) or advertised per model (Codex). */
export const effortsFor = (harnessEfforts: ReadonlyArray<string> | undefined, models: ReadonlyArray<HarnessModel>, model: string | null | undefined) => {
  if (harnessEfforts?.length) return { levels: harnessEfforts, defaultLevel: undefined }
  const m = (model && models.find((x) => x.id === model)) || models.find((x) => x.efforts?.length)
  return { levels: m?.efforts ?? [], defaultLevel: m?.defaultEffort }
}

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
  const detections = useQuery(q.harnesses())
  const defaults = useQuery(q.harnessSettings())
  const detection = detections.data?.find((d) => d.id === harness)
  const models = detection?.models ?? []
  const defaultModel = defaults.data?.harnesses[harness]?.model
  const { levels, defaultLevel } = effortsFor(detection?.efforts, models, model ?? defaultModel)
  const unknownModel = model && !models.some((m) => m.id === model) ? [{ id: model, label: model, provider: undefined }] : []
  const unknownEffort = effort && !levels.includes(effort) ? [effort] : []
  return (
    <>
      {(models.length > 0 || model) && (
        <select
          aria-label="Model for the next message"
          title="Model for the next message (stays selected for this ticket)"
          value={model ?? ""}
          disabled={disabled}
          onChange={(e) => onModel(e.target.value || null)}
          className={cn(pickerClass, "max-w-44")}
          data-testid="composer-model"
        >
          <option value="">{defaultModel ? `Default · ${defaultModel}` : "Default model"}</option>
          {[...models, ...unknownModel].map((m) => (
            <option key={m.id} value={m.id}>
              {m.provider ? `${m.provider} / ${m.label}` : m.label}
            </option>
          ))}
        </select>
      )}
      {(levels.length > 0 || effort) && (
        <select
          aria-label="Reasoning effort for the next message"
          title="Reasoning effort for the next message (stays selected for this ticket)"
          value={effort ?? ""}
          disabled={disabled}
          onChange={(e) => onEffort(e.target.value || null)}
          className={cn(pickerClass, "max-w-28")}
          data-testid="composer-effort"
        >
          <option value="">{defaultLevel ? `Effort · ${defaultLevel}` : "Default effort"}</option>
          {[...levels, ...unknownEffort].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      )}
    </>
  )
}
