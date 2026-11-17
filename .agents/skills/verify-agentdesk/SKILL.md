---
name: verify-agentdesk
description: Verify Agentdesk's browser renderer against an isolated real daemon using Playwright and the built-in mock harness. Use for project and ticket creation, agent approvals and follow-ups, harness defaults, and Inbox read-state journeys with durable evidence.
---

# Verify Agentdesk

Run from the repository root. Read [features/README.md](features/README.md) and the relevant feature file before driving the app. The primary surface is Electron's React renderer; this harness serves the same built renderer in Chromium against the real authenticated HTTP/SSE daemon and SQLite database. It uses the app's existing `mock` agent adapter, as does `apps/desktop/e2e/app.e2e.mjs`.

## Launch

Requirements: Node 22+, pnpm 10, git, installed workspace dependencies, and Playwright Chromium. If missing, use the repo's documented setup:

```sh
pnpm install
pnpm --filter @agentdesk/desktop exec playwright install chromium
```

Build the current working tree, then run the helper:

```sh
pnpm build
node .agents/skills/verify-agentdesk/scripts/verify.mjs inbox
```

The helper creates a disposable git repository with an initial commit and local git identity, a fresh `AGENTDESK_HOME`, and an ephemeral Vite preview port. It launches the daemon using `node --import tsx src/main.ts` from `apps/daemon`, with `AGENTDESK_PORT=0`, source polling disabled, and the preview origin added to the daemon's allowed origins. Inherited Agentdesk overrides are removed. SQLite migrations run on daemon startup; no demo seed or external login is required. Fixtures are created through the UI.

The helper prints `Evidence: ...` immediately. Readiness requires `daemon.json`, authenticated API reads, an empty project/ticket baseline, an available renderer, and the visible project registration form. Ports, daemon data, repository, and browser storage are private to each run. Build output is shared: finish builds before driving and avoid concurrent rebuilds.

## Doctor

The helper's first recorded step is a read-only doctor check on the newly launched instance: authenticated `GET /info`, `/projects`, `/tickets`, and `/settings/harnesses`, plus a renderer fetch. It compares `/info.pid` to the spawned child's PID, checks the data directory and package version, and requires no existing projects or tickets. `doctor.json` records the result and git revision. A healthy HTTP socket alone does not satisfy readiness.

If launch or interaction fails, inspect `report.json` and `daemon.log` before retrying. A failed ownership or baseline check means the instance must not be driven. Retry after correcting the actual prerequisite; stop and report repeated failures of the same prerequisite.

## Drive

```sh
node .agents/skills/verify-agentdesk/scripts/verify.mjs settings
node .agents/skills/verify-agentdesk/scripts/verify.mjs projects
node .agents/skills/verify-agentdesk/scripts/verify.mjs tickets
node .agents/skills/verify-agentdesk/scripts/verify.mjs sessions
node .agents/skills/verify-agentdesk/scripts/verify.mjs inbox
```

Modes are cumulative in that order; no argument means `inbox`, which drives all five. Each invocation starts fresh and cleans up automatically. Actions use repository `data-testid` handles and accessible names, with Playwright waits for visible state rather than fixed sleeps. The helper is executable and can also be invoked directly as `.agents/skills/verify-agentdesk/scripts/verify.mjs settings`.

The mapped paths are specific entry points, not exhaustive app coverage. For an alternate entry point or changed feature, adapt a recipe from the map or existing E2E script, preserve the same isolation and evidence rules, and report exactly what was exercised. Never substitute API writes for a UI journey; API reads corroborate the UI's mutations.

## Evidence

Each invocation prints a fresh `agentdesk-proof-...` directory under the OS temporary directory, separate from disposable state. It retains:

- `report.json`: target, revision, ordered actions, completed journeys, failure details, and cleanup outcomes. The revision alone does not identify uncommitted source changes.
- `doctor.json`, `daemon.log`, `trace.zip`: instance identity, daemon diagnostics, Playwright action trace with snapshots/screenshots.
- Before-action and final `.png`/`.aria.txt` pairs, plus corroborating `settings.json`, `projects.json`, `tickets.json`, or `sessions.json` for completed paths.
- `AGENTDESK_NOTES.md` for the session journey, copied from the actual mock-agent worktree before cleanup.

Inspect the named artifacts after the run. `report.passed` describes the journey; also require successful cleanup and exit status 0. Failed/skipped paths remain unverified. Local evidence survives cleanup but may be removed by normal OS temporary-file retention; copy it to a user-selected durable destination if needed for longer retention.

## Cleanup

The helper closes tracing, Chromium and its preview server; sends SIGTERM to the exact daemon child; waits up to 17 seconds before killing that same child if necessary; and removes its own scratch directory after the daemon exits. Normal failures and SIGINT/SIGTERM run cleanup too. It never kills by process name and never deletes the evidence directory. After abrupt termination that prevents cleanup, use the PID and data directory recorded in `doctor.json` to establish ownership before touching leftovers.

## Coverage limits and other harnesses

The mock adapter writes real local files and exercises approval/SSE/session behavior, but proves no Claude/Codex/OpenCode authentication or model behavior. Browser verification does not cover Electron main/preload, native file dialogs, Dock badges, or closed-window polling. Task-source integrations, diffs/review, workflow gates, and PR creation are outside this initial map.

The existing `pnpm e2e` covers additional review/workflow paths, but uses fixed renderer port 5173 and retains its temporary directories; inspect it before use. `pnpm --filter @agentdesk/desktop e2e:native` checks macOS Electron badge behavior after building, against a stub API rather than the real daemon. Real CLI smoke tests (`AGENTDESK_SMOKE=claude,codex,opencode pnpm test:smoke`) require explicit selection, installed/authenticated CLIs, and may incur real provider work. Do not silently widen a local mock verification into external integrations or PR publishing.

Keep feature entries and helper selectors current when user paths change. Invoke as `$verify-agentdesk`.
