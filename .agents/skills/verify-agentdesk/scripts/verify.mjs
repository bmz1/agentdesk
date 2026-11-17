#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Invoke from the repository root so this also works from a staged skill directory.
const root = process.cwd()
assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name, 'agentdesk', 'Run from the Agentdesk repository root')
const desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { chromium } = require('playwright')
const { preview } = await import(pathToFileURL(require.resolve('vite')).href)
const journeys = ['settings', 'projects', 'tickets', 'sessions', 'inbox']
const target = process.argv[2] ?? 'inbox'
assert(journeys.includes(target), `Journey must be one of: ${journeys.join(', ')}`)
assert(existsSync(join(desktop, 'out/renderer/index.html')), 'Run pnpm build first')
const evidence = mkdtempSync(join(tmpdir(), 'agentdesk-proof-'))
const scratch = mkdtempSync(join(tmpdir(), 'agentdesk-verify-'))
const home = join(scratch, 'home'), repo = join(scratch, 'repo')
mkdirSync(home); mkdirSync(repo)
console.log(`Evidence: ${evidence}`)
const report = { target, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), workingTreeMayBeDirty: true, steps: [], completed: [], passed: false, cleanup: {} }
const record = () => writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
let daemon, server, browser, context, page, conn, daemonLog = '', spawnError
const errors = []
const wait = async (fn, label, timeout = 30000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (spawnError) throw spawnError
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`Daemon exited before ${label}; see daemon.log`)
    const value = await fn()
    if (value) return value
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
const get = async path => {
  const res = await fetch(conn.url + path, { headers: { Authorization: `Bearer ${conn.token}` }, signal: AbortSignal.timeout(5000) })
  assert(res.ok, `${path}: HTTP ${res.status}`)
  return res.json()
}
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value, null, 2))
const capture = async name => {
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true })
  writeFileSync(join(evidence, `${name}.aria.txt`), await page.locator('body').ariaSnapshot())
}
const step = async (label, fn) => {
  const item = { label, status: 'running' }
  report.steps.push(item); record()
  await fn()
  item.status = 'passed'; record()
}
const complete = async name => { await capture(name); report.completed.push(name); record() }
const stopDaemon = async () => {
  if (!daemon || spawnError || daemon.exitCode !== null || daemon.signalCode !== null) return
  const exited = new Promise(r => daemon.once('exit', r))
  daemon.kill('SIGTERM')
  let timer
  await Promise.race([exited, new Promise(r => { timer = setTimeout(r, 17000) })])
  clearTimeout(timer)
  if (daemon.exitCode === null && daemon.signalCode === null) { daemon.kill('SIGKILL'); await exited }
}
let cleaning
const cleanup = () => cleaning ??= (async () => {
  for (const [name, fn] of [
    ['trace', () => context?.tracing.stop({ path: join(evidence, 'trace.zip') })],
    ['browser', () => browser?.close()],
    ['preview', () => server && new Promise((r, reject) => { server.httpServer.close(e => e ? reject(e) : r()); server.httpServer.closeAllConnections() })],
    ['daemon', stopDaemon]
  ]) {
    try { await fn(); report.cleanup[name] = 'closed' } catch (e) { report.cleanup[name] = String(e); process.exitCode = 1 }
  }
  if (!daemon || spawnError || daemon.exitCode !== null || daemon.signalCode !== null) {
    rmSync(scratch, { recursive: true, force: true })
    report.cleanup.scratchRemoved = !existsSync(scratch)
  } else { report.cleanup.scratchRemoved = false; process.exitCode = 1 }
  writeFileSync(join(evidence, 'daemon.log'), daemonLog); record()
})()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.error = `Interrupted by ${signal}`; process.exitCode = 1
  cleanup().then(() => process.exit(1))
})

try {
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'verify@example.invalid'], ['config', 'user.name', 'Verification']]) execFileSync('git', args, { cwd: repo })
  writeFileSync(join(repo, 'README.md'), '# Verification fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: repo })
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial fixture'], { cwd: repo })
  server = await preview({ configFile: join(desktop, 'vite.renderer.config.ts'), root: join(desktop, 'src/renderer'), preview: { host: '127.0.0.1', port: 0, strictPort: true } })
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTDESK_') && k !== 'OTEL_EXPORTER_OTLP_ENDPOINT'))
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: join(root, 'apps/daemon'), env: { ...env, AGENTDESK_HOME: home, AGENTDESK_PORT: '0', AGENTDESK_DISABLE_SOURCE_POLLING: '1', AGENTDESK_ALLOWED_ORIGINS: origin }, stdio: ['ignore', 'pipe', 'pipe']
  })
  daemon.stdout.on('data', b => { daemonLog += b }); daemon.stderr.on('data', b => { daemonLog += b })
  daemon.on('error', e => { spawnError = e; daemonLog += String(e) })
  conn = await wait(() => existsSync(join(home, 'daemon.json')) && JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')), 'connection file')
  await step('doctor: owned daemon, correct version/data directory, authenticated API and empty fixtures', async () => {
    const info = await get('/info')
    assert.equal(info.pid, daemon.pid); assert.equal(info.dataDir, home)
    assert.equal(info.version, JSON.parse(readFileSync(join(root, 'apps/daemon/package.json'), 'utf8')).version)
    assert.deepEqual(await get('/projects'), []); assert.deepEqual(await get('/tickets'), [])
    await get('/settings/harnesses')
    assert((await fetch(origin, { signal: AbortSignal.timeout(5000) })).ok, 'Renderer unavailable')
    save('doctor.json', { ...info, renderer: origin, revision: report.revision })
  })
  browser = await chromium.launch()
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`${origin}/?daemon=${encodeURIComponent(conn.url)}&token=${encodeURIComponent(conn.token)}#/projects`)
  await page.getByTestId('project-name').waitFor()
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
  await step('settings: save mock defaults via Settings; confirm reload and API', async () => {
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await page.getByTestId('default-harness').selectOption('mock')
    await page.locator('[data-testid="harness-mock"] summary').click()
    await page.getByTestId('harness-model-mock').fill('mock-verification-model')
    await page.getByTestId('harness-instructions-mock').fill('Verify every change.')
    await page.getByTestId('harness-permissions-mock').selectOption('ask')
    await capture('settings-before-save')
    await page.getByTestId('harness-defaults-save-mock').click()
    await page.getByRole('status').filter({ hasText: 'Defaults saved.' }).waitFor()
    await page.reload(); await page.locator('[data-testid="harness-mock"] summary').click()
    assert.equal(await page.getByTestId('harness-model-mock').inputValue(), 'mock-verification-model')
    assert.equal(await page.getByTestId('default-harness').inputValue(), 'mock')
    const settings = await get('/settings/harnesses')
    assert.equal(settings.defaultHarness, 'mock')
    assert.deepEqual(settings.harnesses.mock, { model: 'mock-verification-model', permissionMode: 'ask', instructions: 'Verify every change.' })
    save('settings.json', settings); await complete('settings')
  })
  if (target !== 'settings') await step('projects: register disposable git repository via Manage projects', async () => {
    await page.locator('a[aria-label="Manage projects"]').click()
    await page.getByTestId('project-name').fill('Verification Project')
    await page.getByTestId('project-repo').fill(repo)
    await page.getByTestId('project-harness').selectOption('mock')
    await capture('project-before-save'); await page.getByTestId('project-save').click()
    await page.getByTestId('board').waitFor()
    const projects = await get('/projects')
    assert.equal(projects.length, 1); assert.equal(projects[0].name, 'Verification Project')
    assert.equal(projects[0].repoPath, realpathSync(repo)); assert.equal(projects[0].defaultHarness, 'mock')
    save('projects.json', projects)
    await page.reload(); await page.getByTestId('board').waitFor(); await complete('projects')
  })
  if (journeys.indexOf(target) >= 2) await step('tickets: retain draft and create/start one mock ticket via project plus', async () => {
    // The project plus opens the Thread form; switch to the full Ticket form.
    await page.getByTestId('project-new-thread').click(); await page.getByTestId('create-kind-ticket').click()
    await page.getByTestId('ticket-title').fill('Write verification notes')
    await page.keyboard.press('Escape')
    await page.getByTestId('project-new-thread').click(); await page.getByTestId('create-kind-ticket').click()
    assert.equal(await page.getByTestId('ticket-title').inputValue(), 'Write verification notes')
    await page.getByTestId('ticket-harness').selectOption('mock')
    await capture('ticket-before-create'); await page.getByTestId('ticket-create-start').click()
    await page.getByTestId('ticket-heading').filter({ hasText: 'Write verification notes' }).waitFor()
    const tickets = await get('/tickets'), sessions = await get('/sessions')
    assert.equal(tickets.length, 1); assert.equal(tickets[0].title, 'Write verification notes')
    assert.equal(sessions.length, 1); assert.equal(sessions[0].harness, 'mock')
    save('tickets.json', tickets); await complete('tickets')
  })
  if (journeys.indexOf(target) >= 3) await step('sessions: approve mock write, follow up, confirm persisted transcript and file', async () => {
    await page.getByTestId('approval-card').getByRole('button', { name: 'Allow', exact: true }).click()
    await page.getByText('Done with turn 1.', { exact: true }).waitFor()
    await page.getByTestId('composer-input').fill('Also mention verification [noop]')
    await capture('session-before-followup'); await page.getByTestId('composer-send').click()
    await page.getByText('Done with turn 2.', { exact: true }).waitFor()
    await page.reload(); await page.getByTestId('tab-agent').click()
    await page.getByText('Also mention verification [noop]', { exact: true }).waitFor()
    const sessions = await get('/sessions'), file = join(sessions[0].cwd, 'AGENTDESK_NOTES.md')
    assert(existsSync(file), `Mock write missing at ${file}`)
    writeFileSync(join(evidence, 'AGENTDESK_NOTES.md'), readFileSync(file))
    assert(!existsSync(join(repo, 'AGENTDESK_NOTES.md')), 'Mock wrote to original repo')
    save('sessions.json', sessions); await complete('sessions')
  })
  if (target === 'inbox') await step('inbox: mark unread from Agents and clear through Inbox; reload', async () => {
    await page.getByRole('link', { name: /^Agents/ }).click()
    await page.getByRole('button', { name: 'Agents list view', exact: true }).click()
    await page.getByRole('button', { name: 'Mark unread', exact: true }).click(); await page.reload()
    await page.locator('[data-testid="agent-session-row"] [aria-label="Unread"]').waitFor()
    await page.getByRole('link', { name: /^Inbox/ }).click()
    await page.locator('[data-testid="inbox-agent-updates"] [data-testid="agent-session-row"]').waitFor()
    await capture('inbox-before-mark-read')
    await page.getByRole('button', { name: 'Mark all read', exact: true }).click()
    await page.getByText('No unread agent updates.', { exact: true }).waitFor(); await page.reload()
    await page.getByText('No unread agent updates.', { exact: true }).waitFor(); await complete('inbox')
  })
  assert.deepEqual(errors, [], 'Renderer page errors'); report.passed = true
} catch (e) {
  report.error = e.stack ?? String(e)
  if (page && !page.isClosed()) await capture('failure').catch(() => {})
  console.error(report.error); process.exitCode = 1
} finally {
  await cleanup()
  assert(existsSync(join(evidence, 'report.json')), 'Cleanup removed proof')
  console.log(`${report.passed && !process.exitCode ? 'PASSED' : 'FAILED'}: ${report.completed.join(', ') || 'no completed journeys'}; evidence retained at ${evidence}`)
}
