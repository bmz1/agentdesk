# Agentdesk verification map

Read the relevant feature before running the helper. This map starts with five core browser journeys, using the real daemon and its existing mock harness boundary.

## Baseline preconditions

- Run from the Agentdesk repository root with Node 22+, pnpm 10, git, installed dependencies, and Playwright Chromium.
- Run `pnpm build` against the current working tree first.
- The helper owns a fresh daemon home, an ephemeral preview/daemon port pair, an empty SQLite database, a disposable committed repository, and fresh browser storage. It never uses `~/.agentdesk`.
- The built-in doctor must pass. No Jira, Linear, real harness login, or remote repository is needed.

## Driving and proof conventions

Commands are `node .agents/skills/verify-agentdesk/scripts/verify.mjs MODE`. Modes are cumulative: settings → projects → tickets → sessions → inbox. Fixtures are created through preceding UI journeys; each invocation starts from scratch. Stable test IDs and accessible names are in the helper and feature entries.

The helper prints the evidence directory. Read `report.json` for action labels, completed feature IDs, failures and cleanup. Screenshots and ARIA snapshots capture before-action and final state; `trace.zip` captures actions. API JSON and reloads corroborate persistence; the session path also copies the written file. Keep proof outside scratch state. Report feature ID and entry point with artifact paths, attempted commands, and any unmet prerequisites. A successful path does not verify another entry point.

## Features

- [Harness defaults](settings.md): Settings save and reload with API corroboration.
- [Projects](projects.md): Manage projects registration and persisted board navigation.
- [Tickets](tickets.md): project plus, draft preservation, Create & start with mock override.
- [Agent sessions](sessions.md): ticket session approval, follow-up, worktree file and transcript persistence.
- [Inbox](inbox.md): Agents Mark unread → Inbox → Mark all read, preserved across reload.

Sidebar/global creation, board/list variations, session review, workflow gates, external sources, and native Electron behavior need separate proof. See the main skill for the existing broader E2E and native harnesses.
