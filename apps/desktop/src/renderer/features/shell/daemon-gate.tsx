import type { ChangeNotice } from "@agentdesk/contracts"
import { Server } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { EmptyState, Spinner } from "@/components/ui/misc"
import { setConnection } from "@/lib/api"
import { type Connection, resolveConnection } from "@/lib/connection"
import { applyNotice } from "@/lib/queries"
import { subscribeSse } from "@/lib/sse"
import { useUi } from "@/lib/store"

/** Resolves the daemon connection before rendering the app and wires live invalidation notices. */
export const DaemonGate = ({ children }: { children: React.ReactNode }) => {
  const [conn, setConn] = useState<Connection | null | undefined>(undefined)
  const theme = useUi((s) => s.theme)
  const setDaemonConnected = useUi((s) => s.setDaemonConnected)

  useEffect(() => {
    const dark =
      theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    document.documentElement.classList.toggle("dark", dark)
  }, [theme])

  useEffect(() => {
    void resolveConnection().then((c) => {
      setConnection(c)
      setConn(c)
    })
  }, [])

  useEffect(() => {
    if (!conn) return
    return subscribeSse(
      () => "/events",
      (m) => {
        if (m.event === "notice") applyNotice(JSON.parse(m.data) as ChangeNotice)
      },
      { onStatus: setDaemonConnected }
    )
  }, [conn, setDaemonConnected])

  if (conn === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <Spinner className="mr-2" /> Connecting to AgentDesk daemon…
      </div>
    )
  }
  if (conn === null) return <ManualConnect onConnect={(c) => (setConnection(c), setConn(c))} />
  return <>{children}</>
}

const ManualConnect = ({ onConnect }: { onConnect: (c: Connection) => void }) => {
  const [url, setUrl] = useState("http://127.0.0.1:4317")
  const [token, setToken] = useState("")
  return (
    <div className="flex h-full items-center justify-center">
      <div className="w-[420px] rounded-lg border bg-bg-subtle p-4">
        <EmptyState icon={<Server />} title="AgentDesk daemon not found">
          Start it with <code className="font-mono">pnpm dev:daemon</code>. The token is in{" "}
          <code className="font-mono">~/.agentdesk/token</code>.
        </EmptyState>
        <div className="space-y-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Daemon URL" />
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="API token" type="password" />
          <Button
            className="w-full"
            disabled={!token}
            onClick={() => {
              const c = { url, token }
              sessionStorage.setItem("agentdesk.connection", JSON.stringify(c))
              onConnect(c)
            }}
          >
            Connect
          </Button>
        </div>
      </div>
    </div>
  )
}
