// End-to-end test of the renderer against a real daemon (mock harness).
// Usage: pnpm --filter @agentdesk/desktop e2e
import { execSync, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const { chromium } = require("playwright")
const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, "..")
const daemonDir = join(desktop, "../daemon")
const procs = []
const fail = (msg) => {
  console.error(`E2E FAILED: ${msg}`)
  for (const p of procs) p.kill("SIGTERM")
  process.exit(1)
}
const waitFor = async (f, ms = 30_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const v = await f()
    if (v) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  fail("timeout")
}

const home = mkdtempSync(join(tmpdir(), "agentdesk-e2e-"))
const repo = mkdtempSync(join(tmpdir(), "agentdesk-e2e-repo-"))
execSync("git init -q -b main && git config user.email e2e@x && git config user.name e2e", { cwd: repo })
writeFileSync(join(repo, "README.md"), "# e2e\n")
execSync("git add . && git commit -qm init", { cwd: repo })

const daemon = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
  cwd: daemonDir,
  env: { ...process.env, AGENTDESK_HOME: home, AGENTDESK_PORT: "0", AGENTDESK_DISABLE_JIRA_POLLING: "1" },
  stdio: "inherit"
})
procs.push(daemon)
const conn = await waitFor(() => existsSync(join(home, "daemon.json")) && JSON.parse(readFileSync(join(home, "daemon.json"), "utf8")))

execSync("npx vite build --config vite.renderer.config.ts --logLevel warn", { cwd: desktop, stdio: "inherit" })
const preview = spawn("npx", ["vite", "preview", "--config", "vite.renderer.config.ts", "--port", "5173", "--strictPort"], {
  cwd: desktop,
  stdio: "ignore"
})
procs.push(preview)
await waitFor(async () => fetch("http://localhost:5173").then((r) => r.ok).catch(() => false))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (e) => errors.push(String(e)))
try {
  await page.goto(`http://localhost:5173/?daemon=${encodeURIComponent(conn.url)}&token=${conn.token}#/projects`)
  // Register a project through the UI.
  await page.fill('[data-testid="project-name"]', "E2E Service")
  await page.fill('[data-testid="project-repo"]', repo)
  await page.selectOption('[data-testid="project-harness"]', "mock")
  await page.click('[data-testid="project-save"]')
  await page.waitForSelector('[data-testid="board"]')

  // Quick-create a local ticket.
  await page.click('[data-testid="new-ticket"]')
  await page.fill('[data-testid="ticket-title"]', "Write release notes")
  await page.click('[data-testid="ticket-create"]')
  await page.waitForSelector('[data-testid="ticket-heading"]:has-text("Write release notes")')

  // Agent session with approval and follow-up.
  await page.click('[data-testid="tab-agent"]')
  await page.click('[data-testid="start-session"]')
  await page.click('[data-testid="approval-card"] button:has-text("Allow")', { timeout: 20_000 })
  await page.waitForSelector("text=Turn success", { timeout: 20_000 })
  await page.fill('[data-testid="composer-input"]', "Also mention breaking changes [noop]")
  await page.click('[data-testid="composer-send"]')
  await page.waitForSelector("text=Done with turn 2", { timeout: 20_000 })
  await page.reload()
  await page.click('[data-testid="tab-agent"]')
  await page.waitForSelector("text=Also mention breaking changes", { timeout: 20_000 })
  await page.click("text=Stop agent")

  // Workflow through both gates.
  await page.click('[data-testid="tab-workflow"]')
  await page.selectOption('select[title="Override the harness for every agent step"]', "mock")
  await page.waitForSelector('[data-testid="start-run"]:not([disabled])', { timeout: 20_000 })
  await page.click('[data-testid="start-run"]')
  for (let i = 0; i < 60; i++) {
    const st = await page.locator('[data-testid="run-status"]').getAttribute("data-status").catch(() => null)
    if (st === "completed" || st === "failed") break
    const gate = page.locator('[data-testid="approve-gate"]')
    if (await gate.count()) await gate.first().click()
    await page.waitForTimeout(1000)
  }
  const final = await page.locator('[data-testid="run-status"]').getAttribute("data-status")
  if (final !== "completed") fail(`workflow ended ${final}`)
  if (errors.length) fail(`page errors: ${errors.join("\n")}`)
  console.log("E2E PASSED")
} catch (e) {
  await page.screenshot({ path: join(home, "e2e-failure.png") })
  fail(`${e.message} (screenshot: ${join(home, "e2e-failure.png")})`)
} finally {
  await browser.close()
  for (const p of procs) p.kill("SIGTERM")
}
