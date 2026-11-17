import { contextBridge, ipcRenderer } from "electron"

const bridge = {
  platform: process.platform,
  getConnection: (): Promise<{ url: string; token: string; spawnedByApp: boolean } | null> =>
    ipcRenderer.invoke("agentdesk:connection"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("agentdesk:open-external", url),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke("agentdesk:reveal-path", path),
  updateNotificationState: (count: number, seen: Record<string, number>): Promise<void> => ipcRenderer.invoke("agentdesk:notification-state", count, seen),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("agentdesk:pick-directory")
}

contextBridge.exposeInMainWorld("agentdesk", bridge)

export type AgentDeskBridge = typeof bridge
