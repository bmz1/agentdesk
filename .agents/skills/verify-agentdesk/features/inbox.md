# Inbox unread updates

A user can mark a session unread in Agents, find it in Inbox, and clear unread updates without losing that state after reload.

## Sub-features

- `inbox-unread`: Mark unread survives Agents reload and surfaces in Inbox.
- `inbox-clear`: Mark all read clears updates and stays cleared after reload.

## How to get to it (user POV)

- Choose Agents, switch to Agents list view, and use Mark unread on the session.
- Choose the sidebar Inbox link to view agent updates.
- Opening a focused conversation also marks events read; that alternate path is not exercised here.

## Driving it with Playwright

Preconditions:

- Sessions journey completed; exactly one idle mock session exists in fresh browser storage.

- **Run.** `node .agents/skills/verify-agentdesk/scripts/verify.mjs inbox` (the default mode).
- **Mark unread.** Click the link matching `/^Agents/`, button `Agents list view`, then button `Mark unread`. Reload and wait for `[data-testid="agent-session-row"] [aria-label="Unread"]`.
- **Find in Inbox.** Click the link matching `/^Inbox/`; require `[data-testid="inbox-agent-updates"] [data-testid="agent-session-row"]`.
- **Clear and prove.** Click `Mark all read`; require exact text `No unread agent updates.`. Reload and require it again as an independent view of persisted local state.
- **Evidence.** `inbox-before-mark-read.png`, `inbox.png`, corresponding ARIA snapshots and `trace.zip`. Daemon JSON cannot prove this browser-local read state.

## Gotchas

- Fresh browser storage is intentional; do not reuse the user's browser profile.
- Pending approvals and unread updates are separate. This recipe completes approvals before testing read state.
- Chromium cannot prove macOS Dock badges or closed-window polling; use the existing native harness separately.
