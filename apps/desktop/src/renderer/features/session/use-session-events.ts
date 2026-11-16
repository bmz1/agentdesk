import type { StoredAgentEvent } from "@agentdesk/contracts"
import { useEffect, useRef, useState } from "react"
import { subscribeSse } from "@/lib/sse"
import { TranscriptBuilder } from "./transcript-model"

/**
 * Subscribes to a session's durable event stream. The daemon replays persisted
 * events first, then streams live ones; reconnects resume after the last id.
 * Events are batched per animation frame to keep long sessions smooth.
 */
export const useSessionEvents = (sessionId: string | null | undefined) => {
  const builderRef = useRef(new TranscriptBuilder())
  const [, setVersion] = useState(0)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    builderRef.current = new TranscriptBuilder()
    setVersion((v) => v + 1)
    if (!sessionId) return
    let pending: Array<StoredAgentEvent> = []
    let frame: number | undefined
    const flush = () => {
      frame = undefined
      const batch = pending
      pending = []
      if (builderRef.current.apply(batch)) setVersion((v) => v + 1)
    }
    const stop = subscribeSse(
      (lastId) => `/sessions/${sessionId}/events?after=${lastId ?? builderRef.current.lastId}`,
      (m) => {
        if (m.event !== "agent") return
        pending.push(JSON.parse(m.data) as StoredAgentEvent)
        if (frame === undefined) frame = requestAnimationFrame(flush)
      },
      { onStatus: setConnected }
    )
    return () => {
      stop()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [sessionId])

  return { items: builderRef.current.items, lastId: builderRef.current.lastId, connected }
}
