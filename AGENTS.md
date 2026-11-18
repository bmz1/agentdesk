# Repository Guidelines

## Project Structure & Module Organization

AgentDesk is a pnpm workspace with an Electron desktop and an independent Node.js daemon built with Effect.

- `apps/desktop/src/main` and `src/preload`: Electron lifecycle and IPC bridge.
- `apps/desktop/src/renderer`: React routes, feature components, and client state; desktop assets live in `apps/desktop/resources`.
- `apps/daemon/src`: Hono HTTP/SSE transport, Effect services, and runtime layers.
- `apps/cli/src`: the `agentdesk` command line client (plain TypeScript, no runtime dependencies; stable exit codes).
- `packages/`: shared contracts, SQLite schema/migrations, harness adapters, Git operations, workflow engine, and Jira/Linear task sources.
- `workflows/`, `prompts/`, and `docs/`: workflow definitions, agent prompts, and architecture/operations documentation.
- Tests live in each package’s `test/` directory; browser and native desktop journeys live in `apps/desktop/e2e/`.

## Build, Test, and Development Commands

Use Node.js 22+ and pnpm 10.28.0.

- `pnpm install`: install workspace dependencies.
- `pnpm dev:daemon`: start the daemon with source watching.
- `pnpm dev:desktop`: run Electron; it discovers or starts a daemon.
- `pnpm dev:web`: run the browser renderer against a daemon.
- `pnpm seed:demo`: populate demo work using the mock harness.
- `pnpm format`: format the workspace with oxfmt (`pnpm format:check` verifies without writing).
- `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: check formatting, run oxlint, workspace typechecks, tests, and production builds; these are CI checks.
- `pnpm e2e`: exercise the renderer with Playwright and an isolated daemon. First install Chromium with `pnpm --filter @agentdesk/desktop exec playwright install chromium`.
- `pnpm --filter @agentdesk/desktop e2e:native`: verify the macOS Dock badge after building.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, double quotes, and no semicolons; run `pnpm format` before committing. Use kebab-case filenames, PascalCase React components, and camelCase functions. `oxfmt` (`.oxfmtrc.json`, 140 columns) formats the code and `oxlint` (`.oxlintrc.json`) lints the workspace and enforces React hook rules in the renderer.

In React, derive values during render and handle user actions in event handlers; reserve `useEffect` for syncing with systems outside React (subscriptions, timers, the DOM, IPC). Use `useEffectEvent` instead of "latest ref" patterns. `react/set-state-in-effect` is an error; suppress it only with a reason.

Keep HTTP handlers thin and business logic in Effect services. Define shared API schemas in `packages/contracts`. Use TanStack Query for server state and Zustand for local preferences. Add migrations; never rewrite released migrations.

## Testing Guidelines

Use Vitest and `@effect/vitest`; name tests `*.test.ts`. Run focused checks with `pnpm exec vitest run <path>`. Cover behavior, failure paths, persistence, and permission boundaries. No numerical coverage threshold is configured. Real CLI smoke tests require authenticated harnesses: `AGENTDESK_SMOKE=claude,codex,opencode pnpm test:smoke`; `pnpm test:permissions` with the same variable checks every permission mode against the real harnesses.

## Commit & Pull Request Guidelines

History uses short, descriptive commit subjects without a mandatory prefix. Describe the resulting behavior in PRs, link relevant issues, report validation, and include screenshots for UI changes. Document migrations and restart requirements. Keep credentials and local `~/.agentdesk` data out of commits; test with temporary data directories and mock harnesses.
