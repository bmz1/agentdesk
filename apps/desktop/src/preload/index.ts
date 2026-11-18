import { contextBridge, ipcRenderer } from "electron"
import type { UpdateState } from "../main/updater"

const bridge = {
  platform: process.platform,
  getConnection: (): Promise<{ url: string; token: string; spawnedByApp: boolean } | null> =>
    ipcRenderer.invoke("agentdesk:connection"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("agentdesk:open-external", url),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke("agentdesk:reveal-path", path),
  updateNotificationState: (count: number, seen: Record<string, number>): Promise<void> => ipcRenderer.invoke("agentdesk:notification-state", count, seen),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("agentdesk:pick-directory"),
  updates: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke("agentdesk:update-state"),
    check: (): Promise<UpdateState> => ipcRenderer.invoke("agentdesk:update-check"),
    /** Resolves false when the install was cancelled (the app quits otherwise). */
    install: (): Promise<boolean> => ipcRenderer.invoke("agentdesk:update-install"),
    subscribe: (listener: (state: UpdateState) => void): (() => void) => {
      const handler = (_e: unknown, state: UpdateState) => listener(state)
      ipcRenderer.on("agentdesk:update-state", handler)
      return () => void ipcRenderer.removeListener("agentdesk:update-state", handler)
    }
  }
}

contextBridge.exposeInMainWorld("agentdesk", bridge)

export type AgentDeskBridge = typeof bridge
