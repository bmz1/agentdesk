import type { StoredAgentEvent } from "@agentdesk/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/lib/api"
import { subscribeSse } from "@/lib/sse"
import { TranscriptBuilder } from "./transcript-model"

/** Events drawn on open, and per "load earlier" page. Token deltas make up most of them. */
export const TRANSCRIPT_PAGE = 2000

/**
 * Subscribes to a session's durable event stream, end first: the newest page of history is
 * fetched and drawn before the live stream attaches after it, so a long session opens as fast
 * as a short one. Older pages load on request. Live events are batched per animation frame;
 * reconnects resume after the last id.
 */
export const useSessionEvents = (sessionId: string | null | undefined) => {
  const builderRef = useRef(new TranscriptBuilder())
  /** Every event applied so far, ascending: older pages are folded in by rebuilding from it. */
  const eventsRef = useRef<Array<StoredAgentEvent>>([])
  const [, setVersion] = useState(0)
  const [connected, setConnected] = useState(false)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  useEffect(() => {
    builderRef.current = new TranscriptBuilder()
    eventsRef.current = []
    // oxlint-disable-next-line react/set-state-in-effect -- resets the transcript when the subscribed session changes (external stream sync)
    setHasEarlier(false)
    setVersion((v) => v + 1)
    if (!sessionId) return
    let cancelled = false
    let stop: (() => void) | undefined
    let pending: Array<StoredAgentEvent> = []
    let frame: number | undefined
    const apply = (batch: ReadonlyArray<StoredAgentEvent>) => {
      const fresh = batch.filter((e) => e.id > builderRef.current.lastId)
      eventsRef.current.push(...fresh)
      if (builderRef.current.apply(fresh)) setVersion((v) => v + 1)
    }
    const flush = () => {
      frame = undefined
      const batch = pending
      pending = []
      apply(batch)
    }
    const attach = () => {
      stop = subscribeSse(
        (lastId) => `/sessions/${sessionId}/events?after=${lastId ?? builderRef.current.lastId}`,
        (m) => {
          if (m.event !== "agent") return
          pending.push(JSON.parse(m.data) as StoredAgentEvent)
          if (frame === undefined) frame = requestAnimationFrame(flush)
        },
        { onStatus: setConnected }
      )
    }
    api
      .sessionTail(sessionId, TRANSCRIPT_PAGE)
      .then((tail) => {
        if (cancelled) return
        apply(tail)
        setHasEarlier(tail.length === TRANSCRIPT_PAGE)
      })
      // Without the tail the stream replays everything, which is slower but complete.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) attach()
      })
    return () => {
      cancelled = true
      stop?.()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [sessionId])

  const loadEarlier = useCallback(async () => {
    const oldest = eventsRef.current[0]?.id
    if (!sessionId || oldest === undefined || loadingEarlier) return
    setLoadingEarlier(true)
    try {
      const page = await api.sessionTail(sessionId, TRANSCRIPT_PAGE, oldest)
      // A page changes how later events fold (deltas, tool pairs): rebuild from the full list.
      const all = [...page, ...eventsRef.current]
      const builder = new TranscriptBuilder()
      builder.apply(all)
      eventsRef.current = all
      builderRef.current = builder
      setHasEarlier(page.length === TRANSCRIPT_PAGE)
      setVersion((v) => v + 1)
    } finally {
      setLoadingEarlier(false)
    }
  }, [sessionId, loadingEarlier])

  return {
    items: builderRef.current.items,
    plan: builderRef.current.plan,
    lastId: builderRef.current.lastId,
    connected,
    hasEarlier,
    loadingEarlier,
    loadEarlier
  }
}
