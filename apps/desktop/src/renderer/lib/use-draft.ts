import { useState } from "react"

/**
 * A local edit buffer for `value` that starts over whenever `value` changes upstream (a save
 * elsewhere, a refetch). The reset is adjusted during render rather than in an Effect, so the
 * stale draft is never painted and no second commit is needed.
 */
export const useDraft = <T>(value: T) => {
  const [draft, setDraft] = useState(value)
  const [source, setSource] = useState(value)
  if (!Object.is(value, source)) {
    setSource(value)
    setDraft(value)
    return [value, setDraft] as const
  }
  return [draft, setDraft] as const
}
