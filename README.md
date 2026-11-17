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

- **Threads** are for brainstorming and back-and-forth work. Start one with **⌘N** (or the sidebar **+**): write a message, pick a project, go. Threads stay off the board, show up in the sidebar and **Agents**, and become board tickets with **Track on board**. Like tickets, every thread gets its own git worktree and branch: agents never work in your main checkout.
- **Setup script** (project settings): shell commands that run once in every new worktree before its agent starts, for example `pnpm install` and `cp "$AGENTDESK_ROOT_PATH/.env" .env`. The script runs from the worktree with `AGENTDESK_ROOT_PATH` (your main checkout), `AGENTDESK_WORKSPACE_PATH` and `AGENTDESK_BRANCH` set. The conversation shows it as its first step, and the status line reads `Setup script: …` while it runs. A failing script (or one running over 20 minutes) fails the start. Fix it and start again: the same worktree is reused and the script reruns until it succeeds. Workflow runs use it too.
- Use the project’s **+** to create a local ticket with any supported harness. **Create & start** launches it immediately; a failed start keeps the ticket available for retry. Closing the dialog preserves the draft until creation succeeds.
- **One bridge for Claude Code, Codex and OpenCode.** Whatever the harness:
  - When an agent asks you something (Claude's AskUserQuestion, Codex's input requests, OpenCode's question tool), you answer on a card in the conversation. Pick the options or type your own answer.
  - Approvals offer **Allow for session**, so the agent stops asking for the same kind of action.
  - The agent's to-do list or plan shows as a checklist above the conversation, and as `3/7` progress on its card and in its status line.
  - Every turn reports tokens and (for Claude and OpenCode) cost; cards show the session's cost so far.
  - The sidebar shows Claude's and Codex's subscription limits (5-hour and weekly use, with reset times).
  - Where a harness can only approximate a permission mode (Codex has no plan or accept-edits mode AgentDesk can switch on), settings say how AgentDesk enforces it.
- **Agents** offers board and list layouts, grouped into Needs you, Working, Awaiting follow-up, and Recent. Cards show the latest meaningful message plus a one-line status of what a live agent is doing right now (`Bash: pnpm test`, `Needs approval: Write: src/a.ts`), and open the exact session. A finished turn does not mark the ticket Done.
- **Keyboard**: ⌘K palette (every command shows its shortcut), ⌘N new thread, ⌘J next agent that needs you (approvals first, then unread), ⌘1–5 Inbox/Issues/Agents/Workflows/Projects, ⌘, Settings, ⌘B sidebar; in a conversation ⌘⇧A / ⌘⇧D allow or deny the pending tool call, ⌘⇧S allows it for the session, and ⌘. interrupts. Ctrl replaces ⌘ off macOS. Bindings live in one table (`apps/desktop/src/renderer/lib/keymap.ts`).
- **Long conversations** open at the end: the newest events are drawn first and **Load earlier messages** pages back.
- Project and issue views remember their layout and filters. Explicit URL filters take precedence over saved preferences.
- **Chat + changes** opens a resizable split, remembered per ticket. Add feedback with the **+** beside a diff line, then send unresolved comments together to an idle/resumable session or a new installed harness. Stop the current agent before starting another. Comments retain their original code and line context, and stay available for verification and resolution after sending.
- **Settings → Agent harness defaults** configures the harness for new projects plus each harness’s model, permissions, and extra instructions. New projects inherit harness permissions; existing projects keep their explicit policy until changed to **Use harness default**. Ticket models override harness models. Defaults apply to future launches and resumes, including workflow steps.
- **Inbox** includes unread agent updates alongside pending approvals. Opening a focused conversation marks its streamed events read; Mark unread keeps an update available for later. Read state, view preferences, split layouts, and saved review comments stay local to this app installation. The native macOS Dock badge mirrors approvals and unread updates, deduplicating sessions with pending approvals; it continues polling while the desktop app is running with its window closed.

## Command line

`agentdesk` drives the same daemon from a shell, a script or another agent. Build it with `pnpm --filter @agentdesk/cli build` and put `apps/cli/dist/main.js` on your `PATH` as `agentdesk`, or run `pnpm agentdesk <command>` from the checkout.

```sh
agentdesk new "Add a /health endpoint" --wait   # thread in the project containing $PWD; prints the reply
agentdesk ls --attention                        # sessions blocked on you
agentdesk send AD-12 "also add a test" --wait   # ticket identifiers address their current session
agentdesk events --json                         # NDJSON change stream
agentdesk skill setup                           # teach Claude Code to delegate through agentdesk
```

Most commands take `--json`. Exit codes are stable: `0` ok, `1` failed, `2` bad command line, `3` target missing or ambiguous (nothing changed), `4` daemon unreachable, `5` the agent is waiting for an approval or an answer, `130` interrupted. `agentdesk approve <id> --for-session` allows matching requests for the rest of the session; `agentdesk answer <id> <answer>…` answers an agent's questions, one answer per question. The installed skill only says to run `agentdesk skill`, so its instructions always match the installed version. Approval decisions are refused from inside an AgentDesk agent session.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/daemon` | Effect v4 services behind a thin Hono API. Owns SQLite, agents, workflows and Jira sync |
| `apps/desktop` | Electron main/preload plus the Vite React renderer (`src/renderer/routes` = file-based routes) |
| `apps/cli` | `agentdesk` command line client (no runtime dependencies) |
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
pnpm --filter @agentdesk/desktop e2e:native    # after pnpm build: real macOS Electron Dock badge + closed-window polling
```

## Documentation

- [Architecture](docs/architecture.md): runtime topology, services, event pipeline, workflow durability
- [Operations](docs/operations.md): installation, login, persistence, configuration, troubleshooting, provider terms
- [Security](docs/security.md): threat model and safe operating modes
- [Workflows](docs/workflows.md): DSL reference

## Status and non-goals

The MVP is complete through the pilot phase. These are deliberately out of scope: Write-back to task sources, auto-merge, multi-user sync, running several agents in the same worktree, a visual workflow builder, and terminal multiplexing.
