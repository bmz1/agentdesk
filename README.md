# AgentDesk

A local-first desktop control plane for coding agents, where work is organized around **tickets** rather than terminal windows.

Pull selected Jira and Linear issues (or any other pluggable task source) into one board next to local-only tickets. Assign Claude Code, Codex or OpenCode to a ticket and watch its structured live session. Approve tool calls, send follow-ups and review diffs. You can also run a durable **plan → approve → implement → test → review → draft PR** workflow. Agents run in a separate daemon inside per-ticket git worktrees, so closing the UI never stops them.

```
Electron shell ─ React 19 SPA (TanStack Router/Query, Zustand, Tailwind, dnd-kit)
        │  HTTP + SSE (token-authenticated, loopback only)
        ▼
Daemon (Node + Effect v4 + Hono) ── SQLite (Drizzle, WAL) ── durable event log
        ├─ Harness adapters: Claude stream-json · Codex app-server · OpenCode serve
        ├─ Workflow engine (versioned YAML, durable step attempts, approval gates)
        ├─ Git worktrees, draft PRs via gh/glab
        └─ Read-only task sources: Jira (Cloud & DC), Linear — one adapter interface
```

## Quick start

Requirements: Node 22+, pnpm 10, git. Install and log in to whichever harness CLIs you use (`claude`, `codex`, `opencode`). For PRs, install and log in to `gh` or `glab`.

```bash
pnpm install
pnpm dev:daemon            # terminal 1: daemon on 127.0.0.1:4317, data in ~/.agentdesk
pnpm seed:demo             # optional: demo repo + tickets using the built-in mock agent
pnpm dev:desktop           # terminal 2: Electron app (or `pnpm dev:web` for a browser tab)
```

When you run `pnpm dev:web`, open `http://localhost:5173/?daemon=http://127.0.0.1:4317&token=$(cat ~/.agentdesk/token)` once. Electron discovers the daemon automatically through `~/.agentdesk/daemon.json`, and starts it if needed.

## Managing agent work

- Use the project’s **+** to create a local ticket with any supported harness. **Create & start** launches it immediately; a failed start keeps the ticket available for retry. Closing the dialog preserves the draft until creation succeeds.
- **Agents** offers board and list layouts, grouped into Needs you, Working, Awaiting follow-up, and Recent. Cards show the latest meaningful message and open the exact session. A finished turn does not mark the ticket Done.
- Project and issue views remember their layout and filters. Explicit URL filters take precedence over saved preferences.
- **Chat + changes** opens a resizable split, remembered per ticket. Add feedback with the **+** beside a diff line, then send unresolved comments together to an idle/resumable session or a new installed harness. Stop the current agent before starting another. Comments retain their original code and line context, and stay available for verification and resolution after sending.
- **Inbox** includes unread agent updates alongside pending approvals. Opening a focused conversation marks its streamed events read; Mark unread keeps an update available for later. Read state, view preferences, split layouts, and saved review comments stay local to this app installation.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/daemon` | Effect v4 services behind a thin Hono API. Owns SQLite, agents, workflows and Jira sync |
| `apps/desktop` | Electron main/preload plus the Vite React renderer (`src/renderer/routes` = file-based routes) |
| `packages/contracts` | Effect Schema contracts shared by the daemon and the UI (canonical agent events, models, request bodies) |
| `packages/db` | Drizzle schema and embedded migrations |
| `packages/harness-core` | `HarnessAdapter`/`HarnessSession` contract, process supervision, mock harness, redaction |
| `packages/harness-{claude,codex,opencode}` | Protocol adapters and normalizers |
| `packages/workflows` | YAML DSL, compiler and the pure `nextAction` state machine |
| `packages/task-source` | Task source adapter contract and registry |
| `packages/jira`, `packages/linear` | Task source adapters (Jira Cloud/DC client + ADF to text; Linear GraphQL client) |
| `packages/git` | Worktrees, diffs, commits, PR providers |
| `workflows/`, `prompts/` | Built-in workflow definitions and prompt files |

## Testing

```bash
pnpm typecheck
pnpm test                                    # unit, protocol fixtures, daemon integration, crash recovery
AGENTDESK_SMOKE=claude,codex,opencode pnpm test:smoke   # real CLIs (each must be logged in)
pnpm --filter @agentdesk/desktop exec playwright install chromium  # once, for browser tests
pnpm e2e                                     # Playwright: renderer + real daemon, full ticket → PR flow
```

## Documentation

- [Architecture](docs/architecture.md): runtime topology, services, event pipeline, workflow durability
- [Operations](docs/operations.md): installation, login, persistence, configuration, troubleshooting, provider terms
- [Security](docs/security.md): threat model and safe operating modes
- [Workflows](docs/workflows.md): DSL reference

## Status and non-goals

The MVP is complete through the pilot phase. These are deliberately out of scope: Write-back to task sources, auto-merge, multi-user sync, running several agents in the same worktree, a visual workflow builder, and terminal multiplexing.
