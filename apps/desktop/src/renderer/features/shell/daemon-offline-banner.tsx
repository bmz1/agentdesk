import { WifiOff } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useUi } from "@/lib/store"

/**
 * A warning while the daemon can't be reached. Agents' conversations survive a restart, so nothing
 * else in the app turns into an error; the banner goes away by itself once the daemon is back.
 */
export const DaemonOfflineBanner = () => {
  const connected = useUi((s) => s.daemonConnected)
  const seen = useRef(false)
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (connected) {
      seen.current = true
      // oxlint-disable-next-line react/set-state-in-effect -- TODO: move the offline timer into the store (useEffect cleanup, group B)
      setShow(false)
      return
    }
    // Ignore the first connect and blips shorter than a restart.
    if (!seen.current) return
    const t = setTimeout(() => setShow(true), 1500)
    return () => clearTimeout(t)
  }, [connected])
  if (!show) return null
  return (
    <div role="status" className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-xs text-warning" data-testid="daemon-offline">
      <WifiOff className="size-3.5 shrink-0" />
      <span>The AgentDesk daemon isn't reachable. Reconnecting… Agents' conversations resume once it's back.</span>
    </div>
  )
}
