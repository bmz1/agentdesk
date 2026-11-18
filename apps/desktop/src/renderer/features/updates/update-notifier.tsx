import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { bridge } from "@/lib/connection"
import { useUpdateState } from "@/lib/updates"

/** Offers a downloaded update once per version; Settings → Updates keeps the button afterwards. */
export const UpdateNotifier = () => {
  const state = useUpdateState()
  const announced = useRef<string>(undefined)
  useEffect(() => {
    if (state?.status !== "ready" || !state.availableVersion || announced.current === state.availableVersion) return
    announced.current = state.availableVersion
    toast(`AgentDesk ${state.availableVersion} is ready`, {
      id: "agentdesk-update",
      description: "Restart to install. Running agent work will be interrupted.",
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Restart", onClick: () => void bridge()?.updates?.install() }
    })
  }, [state])
  return null
}
