// macOS integration check of the real Electron bridge and Dock, isolated from user data.
// Run after building: pnpm --filter @agentdesk/desktop e2e:native
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { _electron as electron } from "playwright"

if (process.platform !== "darwin") {
  console.log("Native Dock badge test skipped: macOS only")
  process.exit(0)
}
const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)))
const home = mkdtempSync(join(tmpdir(), "agentdesk-native-badge-"))
let sessions = []
let approvals = []
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }
  const path = req.url.split("?")[0]
  const value =
    path === "/health"
      ? { ok: true }
      : path === "/info"
        ? { version: "test", persistent: true, activeSessions: 0, activeRuns: 0, dataDir: home }
        : path === "/sessions"
          ? sessions
          : path === "/approvals"
            ? approvals
            : []
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(value))
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
writeFileSync(
  join(home, "daemon.json"),
  JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token: "native-test", pid: process.pid, version: "test" })
)
const entry = join(home, "launch.mjs")
writeFileSync(
  entry,
  `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(join(home, "desktop"))});\nawait import(${JSON.stringify(pathToFileURL(join(desktop, "out/main/index.js")).href)});\n`
)
let application
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  application = await electron.launch({
    args: [entry],
    env: { ...process.env, AGENTDESK_HOME: home, AGENTDESK_NO_SPAWN: "1", ELECTRON_RENDERER_URL: "" }
  })
  const page = await application.firstWindow()
  await page.waitForFunction(() => !!window.agentdesk?.updateNotificationState)
  await page.getByRole("link", { name: /^Inbox/ }).click()
  await page.getByText("Nothing needs your attention", { exact: true }).waitFor()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.hide()))
  await page.evaluate(() => window.agentdesk.updateNotificationState(4, { done: 5 }))
  const badge = () => application.evaluate(({ app }) => app.dock.getBadge())
  const ipcBadge = await badge()
  if (ipcBadge !== "4") throw new Error(`IPC Dock badge: expected 4, got ${JSON.stringify(ipcBadge)}`)
  await page.evaluate(() => window.agentdesk.updateNotificationState(0, { done: 5 }))
  await waitFor(async () => (await badge()) === "", "zero clears the Dock badge")
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close()))
  sessions = [
    { id: "done", state: "idle", lastEventId: 6 },
    { id: "approval", state: "waiting_for_approval", lastEventId: 9 }
  ]
  approvals = [{ sessionId: "approval" }]
  await waitFor(async () => (await badge()) === "2", "main-process polling updates badge with no window")
  sessions = []
  approvals = []
  await waitFor(async () => (await badge()) === "", "main-process polling clears handled items")
  console.log("NATIVE DOCK BADGE E2E PASSED")
} finally {
  await application?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}
