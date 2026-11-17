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
writeFileSync(join(repo, ".gitignore"), ".agentdesk-setup-ran\n")
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

// AGENTDESK_E2E_CHROMIUM points at an already installed Chromium when the pinned build is missing.
const browser = await chromium.launch(process.env.AGENTDESK_E2E_CHROMIUM ? { executablePath: process.env.AGENTDESK_E2E_CHROMIUM } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const assertDropdowns = async () => {
  const problems = await page.locator("select:visible").evaluateAll((selects) => selects.flatMap((select) => {
    const style = getComputedStyle(select)
    const rect = select.getBoundingClientRect()
    const parent = select.parentElement.getBoundingClientRect()
    const broken = style.appearance !== "none" || parseFloat(style.paddingRight) < 24 || style.backgroundSize !== "12px 12px" || rect.right > parent.right + 1 || rect.left < parent.left - 1
    return broken ? [select.getAttribute("aria-label") || select.dataset.testid || select.value] : []
  }))
  if (problems.length) fail(`dropdown overflow or arrow spacing: ${problems.join(", ")}`)
}
const errors = []
page.on("pageerror", (e) => errors.push(String(e)))
// Interaction budgets. Generous enough for a loaded CI machine; they catch regressions such as
// a refetch round trip creeping back between a daemon event and the screen.
const timings = {}
const budget = async (name, ms, act, until) => {
  const start = performance.now()
  await act()
  await until()
  const elapsed = Math.round(performance.now() - start)
  timings[name] = elapsed
  if (elapsed > ms) fail(`${name} took ${elapsed}ms (budget ${ms}ms)`)
}
// Session state arrives with the change notice; list refetches mean the push path regressed.
let sessionListFetches = []
page.on("request", (r) => {
  const url = new URL(r.url())
  if (r.method() === "GET" && /^\/(sessions|tickets\/[^/]+\/sessions)$/.test(url.pathname)) sessionListFetches.push(url.pathname + url.search)
})
try {
  await page.goto(`http://localhost:5173/?daemon=${encodeURIComponent(conn.url)}&token=${conn.token}#/projects`)
  // Configure daemon-owned harness defaults before creating a project.
  await page.getByRole("link", { name: "Settings", exact: true }).click()
  await page.selectOption('[data-testid="default-harness"]', "mock")
  await page.locator('[data-testid="harness-mock"] summary').click()
  await page.fill('[data-testid="harness-model-mock"]', "mock-default-model")
  await page.fill('[data-testid="harness-instructions-mock"]', "Verify every change.")
  await page.selectOption('[data-testid="harness-permissions-mock"]', "ask")
  await page.click('[data-testid="harness-defaults-save-mock"]')
  await page.getByRole("status").filter({ hasText: "Defaults saved." }).waitFor()
  await page.reload()
  await page.locator('[data-testid="harness-mock"] summary').click()
  if (await page.inputValue('[data-testid="harness-model-mock"]') !== "mock-default-model") fail("harness defaults did not persist")
  await assertDropdowns()
  await page.setViewportSize({ width: 960, height: 900 })
  await assertDropdowns()
  await page.screenshot({ path: join(home, "harness-settings.png") })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('a[aria-label="Manage projects"]').click()
  // Register a project through the UI.
  await page.fill('[data-testid="project-name"]', "E2E Service")
  await page.fill('[data-testid="project-repo"]', repo)
  await page.selectOption('[data-testid="project-harness"]', "claude")
  // Every new worktree runs this before its agent starts.
  await page.fill('[data-testid="project-setup-command"]', 'echo "set up from $AGENTDESK_ROOT_PATH" > .agentdesk-setup-ran')
  await assertDropdowns()
  await page.click('[data-testid="project-save"]')
  await page.waitForSelector('[data-testid="board"]')

  // Create from the project's plus button with a harness override.
  await page.click('[data-testid="project-new-thread"]')
  await page.click('[data-testid="create-kind-ticket"]')
  const selectedProject = await page.inputValue('[data-testid="ticket-project"]')
  const projectId = new URL(page.url()).hash.split("/projects/")[1]?.split("?")[0]
  if (selectedProject !== projectId) fail("project plus did not preselect its project")
  await page.fill('[data-testid="ticket-title"]', "Write release notes")
  await page.keyboard.press("Escape")
  await page.click('[data-testid="project-new-thread"]')
  await page.click('[data-testid="create-kind-ticket"]')
  if (await page.inputValue('[data-testid="ticket-title"]') !== "Write release notes") fail("creation draft lost on close")
  await page.selectOption('[data-testid="ticket-harness"]', "mock")
  await assertDropdowns()
  // A failed launch keeps the created ticket for retry instead of duplicating it.
  await page.route("**/tickets/*/sessions", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Temporary start failure" }) }), { times: 1 })
  await page.click('[data-testid="ticket-create-start"]')
  await page.getByRole("alert").filter({ hasText: "Ticket created; agent could not start" }).waitFor()
  const get = (path) => fetch(conn.url + path, { headers: { Authorization: `Bearer ${conn.token}` } }).then((r) => r.json())
  if ((await get("/tickets")).length !== 1) fail("failed start did not preserve a single ticket")
  await page.click('[data-testid="ticket-create-start"]')
  await page.waitForSelector('[data-testid="ticket-heading"]:has-text("Write release notes")')

  // Agent session with approval and follow-up.
  const ticketUrl = page.url()
  if ((await get("/tickets")).length !== 1) fail("retry created a duplicate ticket")
  const [started] = await get("/sessions")
  if (started.harness !== "mock") fail("create and start ignored the harness override")
  await page.getByRole("link", { name: /^Agents/ }).click()
  await page.locator('[data-testid="agents-attention"] [data-testid="agent-session-row"]').waitFor()
  await page.locator('[data-testid="agent-preview"]').filter({ hasText: "AGENTDESK_NOTES" }).waitFor()
  await page.screenshot({ path: join(home, "agents-board.png") })
  await budget("open session with pending approval", 1500,
    () => page.getByRole("link", { name: /Write release notes/ }).last().click(),
    () => page.locator('[data-testid="approval-card"]').waitFor())
  sessionListFetches = []
  await budget("allow → approval card gone", 1000,
    () => page.click('[data-testid="approval-card"] button:has-text("Allow")'),
    () => page.locator('[data-testid="approval-card"]').waitFor({ state: "detached" }))
  await page.waitForSelector("text=Done with turn 1", { timeout: 20_000 })
  if (sessionListFetches.length) fail(`session state changes refetched session lists: ${sessionListFetches.join(", ")}`)
  await budget("command palette open", 400,
    () => page.keyboard.press("ControlOrMeta+k"),
    () => page.getByPlaceholder("Search tickets or type a command…").waitFor())
  if (!(await page.locator("[cmdk-item]").filter({ hasText: "Next agent that needs you" }).innerText()).match(/(⌘|Ctrl\+)J/)) fail("palette does not show shortcut hints")
  await page.keyboard.press("Escape")
  await page.fill('[data-testid="composer-input"]', "Also mention breaking changes [noop]")
  await page.click('[data-testid="composer-send"]')
  await page.waitForSelector("text=Done with turn 2", { timeout: 20_000 })
  await page.reload()
  await page.click('[data-testid="tab-agent"]')
  await page.waitForSelector("text=Also mention breaking changes", { timeout: 20_000 })
  // Keep conversation and changes visible, resize using the keyboard, and save review feedback.
  await page.click('[data-testid="toggle-agent-split"]')
  await page.locator('[data-testid="agent-workspace"]').waitFor()
  const separator = page.getByRole("separator", { name: "Resize conversation and changes" })
  await separator.focus()
  await page.keyboard.press("ArrowRight")
  if (await separator.getAttribute("aria-valuenow") !== "55") fail("split did not resize")
  await page.locator('[data-testid="diff-comment-line"]').first().click()
  await page.fill('[data-testid="review-comment-input"]', "Clarify the release notes [noop]")
  await page.click('[data-testid="review-comment-save"]')
  await page.reload()
  await page.getByText("Clarify the release notes [noop]", { exact: true }).waitFor()
  if (await separator.getAttribute("aria-valuenow") !== "55") fail("split layout did not persist")
  await page.waitForFunction(() => document.querySelector('[data-testid="review-target"]')?.value && !document.querySelector('[data-testid="review-target"]').value.startsWith("new:"))
  await assertDropdowns()
  await page.setViewportSize({ width: 960, height: 900 })
  await assertDropdowns()
  await page.screenshot({ path: join(home, "dropdowns-narrow.png") })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: join(home, "chat-review.png") })
  await page.click('[data-testid="review-send"]')
  await page.getByText("Feedback sent. Comments stay here for verification.", { exact: true }).waitFor()
  await page.waitForSelector("text=Done with turn 3", { timeout: 20_000 })
  await page.getByRole("button", { name: "Resolve", exact: true }).click()
  await page.getByRole("button", { name: "Reopen", exact: true }).waitFor()

  // Dashboard preferences and explicit unread state survive reload and navigation.
  await page.getByRole("link", { name: /^Agents/ }).click()
  await page.getByRole("button", { name: "Agents list view", exact: true }).click()
  await page.getByRole("combobox", { name: "Filter agents by harness" }).selectOption("mock")
  await page.getByRole("button", { name: "Mark unread", exact: true }).click()
  await page.reload()
  if (await page.getByRole("button", { name: "Agents list view", exact: true }).getAttribute("aria-pressed") !== "true") fail("agent layout was not remembered")
  if (await page.getByRole("combobox", { name: "Filter agents by harness" }).inputValue() !== "mock") fail("agent filter was not remembered")
  await page.locator('[data-testid="agent-session-row"] [aria-label="Unread"]').waitFor()
  await page.getByRole("link", { name: /^Inbox/ }).click()
  await page.locator('[data-testid="inbox-agent-updates"] [data-testid="agent-session-row"]').waitFor()
  await page.getByRole("button", { name: "Mark all read", exact: true }).click()
  await page.getByText("No unread agent updates.", { exact: true }).waitFor()

  // ⌘J jumps to the agent that needs attention.
  await page.getByRole("link", { name: /^Agents/ }).click()
  await page.getByRole("button", { name: "Mark unread", exact: true }).first().click()
  await budget("⌘J to the agent that needs you", 1000,
    () => page.keyboard.press("ControlOrMeta+j"),
    () => page.waitForURL((u) => u.hash.includes(`session=${started.id}`)))

  // Project list and filters are restored when returning through the sidebar.
  await page.locator('[data-testid="sidebar-project"]').click()
  await page.getByRole("button", { name: "List view", exact: true }).click()
  await page.getByRole("combobox", { name: "Filter tickets by harness" }).selectOption("mock")
  await page.getByRole("link", { name: /^Agents/ }).click()
  await page.locator('[data-testid="sidebar-project"]').click()
  await page.waitForFunction(() => document.querySelector('[aria-label="List view"]')?.getAttribute("aria-pressed") === "true")
  if (await page.getByRole("combobox", { name: "Filter tickets by harness" }).inputValue() !== "mock") fail("project filter was not remembered")
  await page.goto(ticketUrl)
  await page.getByRole("button", { name: "Stop agent", exact: true }).click()

  // Workflow through both gates.
  await page.click('[data-testid="tab-workflow"]')
  await page.selectOption('select[title="Override the harness for every agent step"]', "mock")
  await assertDropdowns()
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

  // A thread: ⌘N, one message, in its own set-up worktree, kept off the board until tracked.
  await page.keyboard.press("ControlOrMeta+n")
  await page.fill('[data-testid="thread-prompt"]', "How should we structure the release notes? [noop]")
  await page.selectOption('[data-testid="ticket-harness"]', "mock")
  await page.keyboard.press("ControlOrMeta+Enter")
  await page.waitForSelector('[data-testid="ticket-heading"]:has-text("How should we structure the release notes?")')
  await page.waitForSelector('[data-testid="worktree-branch"]')
  await page.getByText("Setup script").first().waitFor()
  await page.screenshot({ path: join(home, "thread-setup.png") })
  const thread = (await get("/tickets?tracked=0"))[0]
  if (!thread) fail("thread was not created untracked")
  const [threadSession] = await get(`/tickets/${thread.id}/sessions`)
  if (!threadSession || threadSession.cwd === repo) fail("thread agent ran in the main checkout")
  if (!readFileSync(join(threadSession.cwd, ".agentdesk-setup-ran"), "utf8").startsWith("set up from /")) fail("setup script did not run in the thread's worktree")
  if ((await get("/tickets?tracked=1")).some((t) => t.id === thread.id)) fail("thread appeared on the board")
  await page.click('[data-testid="track-thread"]')
  await page.waitForSelector('[data-testid="ticket-status"]')
  if (!(await get(`/tickets/${thread.id}`)).tracked) fail("tracking the thread did not put it on the board")
  if (errors.length) fail(`page errors: ${errors.join("\n")}`)
  console.log(`E2E timings (ms): ${JSON.stringify(timings)}`)
  console.log(`E2E PASSED (screenshots: ${home})`)
} catch (e) {
  await page.screenshot({ path: join(home, "e2e-failure.png") })
  fail(`${e.message} (screenshot: ${join(home, "e2e-failure.png")})`)
} finally {
  await browser.close()
  for (const p of procs) p.kill("SIGTERM")
}
