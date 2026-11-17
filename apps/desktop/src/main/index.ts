import { join } from "node:path"
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from "electron"
import { ensureDaemon } from "./daemon"
import appIcon from "../../resources/icon.png?asset"

app.setName("AgentDesk")
if (process.platform === "win32") app.setAppUserModelId("com.agentdesk.desktop")

const isDev = !!process.env.ELECTRON_RENDERER_URL

const CSP = [
  "default-src 'self'",
  // Dev only: the Vite React Refresh preamble is an inline script.
  `script-src 'self'${isDev ? " 'unsafe-inline'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // blob: shows images fetched from the daemon with its token (attachments, screenshots).
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // Only the local daemon (loopback) may be contacted from the renderer.
  `connect-src 'self' http://127.0.0.1:* http://localhost:*${isDev ? " ws://localhost:*" : ""}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ")

const createWindow = () => {
  const win = new BrowserWindow({
    title: "AgentDesk",
    icon: appIcon,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1011" : "#ffffff",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })
  win.once("ready-to-show", () => win.show())

  // Never navigate the app window away; open http(s) links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev ? url.startsWith(process.env.ELECTRON_RENDERER_URL!) : url.startsWith("file://")
    if (!allowed) event.preventDefault()
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, "../renderer/index.html"))
}

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.setIcon(appIcon)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  // Narrow, explicit bridge. No arbitrary file or process access is exposed to the renderer.
  ipcMain.handle("agentdesk:connection", async () => (await ensureDaemon()) ?? null)
  ipcMain.handle("agentdesk:open-external", async (_e, url: unknown) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) await shell.openExternal(url)
  })
  ipcMain.handle("agentdesk:reveal-path", async (_e, path: unknown) => {
    if (typeof path === "string" && path.startsWith("/")) shell.showItemInFolder(path)
  })
  ipcMain.handle("agentdesk:pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  // The daemon keeps running agent work in the background; only the UI quits.
  if (process.platform !== "darwin") app.quit()
})
