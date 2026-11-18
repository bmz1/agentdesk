# Security

## Local API
- Binds to `127.0.0.1` only. Every request needs `Authorization: Bearer <token>`, a 32-byte secret stored in `~/.agentdesk/token` with mode 0600 and compared in constant time.
- `Host` must be a loopback name, which defeats DNS rebinding. A request with an `Origin` header must use an allow-listed origin (dev server, `file://`); configure more with `AGENTDESK_ALLOWED_ORIGINS`.
- SSE uses fetch with the Authorization header instead of tokens in URLs.
- The `agentdesk` CLI reads the same token from `~/.agentdesk/daemon.json` (or `AGENTDESK_URL` + `AGENTDESK_TOKEN`). Agent processes get `AGENTDESK_SESSION_ID`, and the CLI refuses `approve`/`deny`/`answer` when it is set, so a delegating agent is not handed an easy way to approve its own tool calls. This is a guard rail, not a boundary: an agent can read anything your user account can, including the token file (see *Agent execution*).

## Desktop
- `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP (`connect-src` limited to loopback), blocked navigation and `window.open`, and permission requests denied.
- The preload exposes four narrow functions. The renderer cannot run arbitrary file or process operations.
- Untrusted Jira and agent text is always rendered as text. No `innerHTML` is used, and ADF is converted to inert text.

## Credentials
- Task source tokens (Jira, Linear) are stored in the macOS Keychain or Linux Secret Service, passed on stdin and never on argv. SQLite stores only an opaque reference. A 0600 file store exists only behind `AGENTDESK_ALLOW_FILE_CREDENTIALS=1`.
- Agent processes never receive `JIRA_*`, `ATLASSIAN_API_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN` or `AGENTDESK_TOKEN`. Provider CLIs (`gh`, `glab`) get their own tokens back explicitly, and only for PR operations.
- Harnesses use their own supported login. AgentDesk never reads, copies or proxies subscription credentials.

## Agent execution
- **A git worktree isolates branches; it is not a sandbox.** Agents can read and write anything your user account can.
- Permission modes, set per project:
  - `ask` (default): risky tool calls produce approval cards. Reading and searching never ask (OpenCode still asks before reading `.env` files).
    **Allow for session** widens that for the rest of the agent process, in the harness's own terms: Claude applies the permission update it proposed (for edits, accept-edits mode), Codex approves that kind of request for the session, and OpenCode allows the pattern it proposed (for example `echo *`). It ends with the process; a resumed conversation asks again. On Codex, `ask` and `accept_edits` run in a read-only sandbox with the `on-request` approval policy (`untrusted` is retired upstream): reads and read-only commands run, edits and writing commands escalate to an approval. Under `accept_edits` AgentDesk approves the edit requests itself, so only writing commands ask.
  - `accept_edits`: file edits are allowed, while shell and network still ask (Codex: workspace-write sandbox).
  - `auto`: the harness reviews its own approvals. Claude runs with `--permission-mode auto` (a classifier approves routine actions and blocks risky ones); Codex routes escalations to its `auto_review` subagent inside the workspace-write sandbox. OpenCode has no reviewer, so edits, web lookups and subagents are allowed and shell still asks. Only escalations reach AgentDesk as approval cards. The reviewer is a model, not a sandbox.
  - `plan`: read-only planning. OpenCode has no plan agent, and can't tell a read-only command from a writing one, so its plan mode denies edits and shell commands outright.
  - `unrestricted`: refused unless `AGENTDESK_SANDBOX_CMD` configures a real sandbox command prefix, for example `["bwrap","--bind","{cwd}","{cwd}",...]` or a container runner. That prefix wraps the harness process.
- PRs need explicit approval, are created as drafts and are never merged. Every task source is read-only.
- Secrets matching common formats (GitHub, GitLab, Atlassian, AWS, Slack, OpenAI/Anthropic keys, private keys, `Authorization` headers, `password=`-style assignments) are redacted from persisted agent events, logs and diff previews. This is best effort; do not rely on it as the only control.

## Audit
Workflow starts, step outcomes, approvals (with actor and note), Jira imports and status changes, worktree creation and removal, and PR creation are recorded in `activity_events`. Retention pruning (`AGENTDESK_RETENTION_DAYS`, default 90) removes old *transcripts* only, never audit records.

## Pilot checklist (SEON)
- Confirm the Jira deployment (Cloud or Data Center), use a narrowly scoped JQL, and issue a read-only token for the pilot user.
- Use only approved harness accounts and model providers. Use subscription logins only in the authorized user's interactive context, in line with each provider's terms; they cannot be pooled into a shared unattended service.
- Pilot only on non-production repositories. Give agents no production credentials.
- Keep `ask` or `accept_edits` mode unless a reviewed sandbox command is configured.
