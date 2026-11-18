# Operations

## Install
```bash
pnpm install
pnpm --filter @agentdesk/daemon build        # → apps/daemon/dist/main.js
pnpm --filter @agentdesk/desktop build       # → apps/desktop/out
```

### Persistence
By default the desktop app starts the daemon as a **detached background process**. Agent work continues when the window closes. It stops if the daemon is killed, on logout, or on reboot, and the UI says so. For real persistence, install the per-user service:

```bash
pnpm --filter @agentdesk/daemon install-service              # macOS launchd or Linux systemd --user
pnpm --filter @agentdesk/daemon install-service --uninstall
```

The service runs with `AGENTDESK_PERSISTENT=1`. The desktop app uses the running service automatically.

## Releases
Desktop installers are built with electron-builder. `pnpm package:desktop` builds the daemon and desktop, stages them in `apps/desktop/build/app`, and writes installers for the current OS to `apps/desktop/release` (pass `-- --linux dir` for an unpacked build). The packaged app runs its bundled daemon on Electron's Node (`ELECTRON_RUN_AS_NODE`) from `app.asar.unpacked/daemon`, with `workflows/` and `prompts/` in the app's resources directory.

To publish a release, bump `version` in `apps/desktop/package.json`, merge, then push a matching tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

`.github/workflows/release.yml` packages macOS (dmg and zip, arm64 and x64) and Linux (AppImage and deb, x64), then creates a **draft** GitHub release with the installers and generated notes; publish it from the Releases page. A tag that does not match the app version fails the run. Running the workflow manually builds the installers as workflow artifacts without a release.

macOS builds are unsigned unless the repository has the `CSC_LINK` and `CSC_KEY_PASSWORD` secrets (a base64 Developer ID `.p12` and its password). Add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` to notarize. Unsigned downloads are quarantined by Gatekeeper; clear that with `xattr -dr com.apple.quarantine /Applications/AgentDesk.app`.

## Harness login
| Harness | Install | Login |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` (interactive login) |
| Codex | `npm i -g @openai/codex` | `codex login` |
| OpenCode | `npm i -g opencode-ai` | `opencode auth login` |

Settings → Agent harnesses shows detected versions. Verify end to end with `AGENTDESK_SMOKE=claude pnpm test:smoke`.

**Provider terms:** use each harness with its official login, in your own interactive user context, and only with providers and accounts your organization has approved for the code involved.

## Configuration (environment variables)
| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTDESK_HOME` | `~/.agentdesk` | Data dir (DB, token, worktrees, artifacts, logs) |
| `AGENTDESK_PORT` | `4317` | API port (`0` = ephemeral) |
| `AGENTDESK_MAX_RUNS` / `AGENTDESK_MAX_RUNS_PER_PROJECT` | `3` / `2` | Workflow concurrency |
| `AGENTDESK_SANDBOX_CMD` | unset | Sandbox prefix (JSON array); required for `unrestricted` mode |
| `AGENTDESK_RETENTION_DAYS` | `90` | Transcript retention for ended sessions |
| `AGENTDESK_WORKFLOWS_DIR` / `AGENTDESK_PROMPTS_DIR` | repo `workflows/`, `prompts/` | Workflow sources |
| `AGENTDESK_ALLOWED_ORIGINS` | — | Extra allowed UI origins |
| `AGENTDESK_DISABLE_SOURCE_POLLING` | — | `1` disables background polling of task sources (`AGENTDESK_DISABLE_JIRA_POLLING` still works) |
| `AGENTDESK_ALLOW_FILE_CREDENTIALS` | — | `1` opts into the 0600 file credential store |
| `AGENTDESK_{CLAUDE,CODEX,OPENCODE}_BIN` | PATH lookup | Harness binary overrides |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP/HTTP collector base URL (e.g. `http://127.0.0.1:4318`); enables trace, log and metric export |

## Files
```
~/.agentdesk/
  agentdesk.db (+ -wal/-shm)   SQLite, WAL mode
  token, daemon.json, daemon.lock
  worktrees/<project>/<ticket>-<id>/   one per ticket or thread, and per workflow run (set up by the project's setup script)
  artifacts/<runId>/                   plans, reviews, check logs
  logs/daemon.log                      JSON lines, redacted, rotated at 10 MB
```

## Recovery behaviour
- **UI closed:** nothing happens to agents.
- **Daemon restarted or crashed:** live sessions become `interrupted`, and a follow-up resumes the provider conversation. In-flight workflow runs become `interrupted`; press **Resume** to re-run the interrupted step as a new attempt. Approval gates that were waiting stay waiting. PR creation reuses an existing PR for the branch.
- **Threads from before read-only mode was removed** (migration 7): a conversation that ran in the main checkout cannot resume there, so a follow-up to it is refused. Start a new session from the thread instead. It uses the worktree the agent already created and AgentDesk adopted, or a new one.
- **Setup script failed:** the session shows the script's output as its first step and ends `failed`. Fix the script under the project's settings and start the agent again; the worktree is kept and set up again.
- **Worktree cleanup** refuses to remove uncommitted changes unless you force it. The branch is always kept.

## Troubleshooting
- *"Another AgentDesk daemon is already using …"*: a daemon already runs for this data dir. Check `daemon.json` for its pid.
- *Harness shows "not installed"*: the daemon's PATH differs from your shell's. Set `AGENTDESK_*_BIN` or the service's PATH.
- *Jira "rejected credentials"*: use an email plus API token for Cloud, or a PAT for Data Center. Re-enter the token in Settings → Task sources.
- *Imported tickets not on a project board*: task source connections are global, so new imports have no project. Find them under **Unassigned** in the sidebar (All issues → project filter "Unassigned") and pick a project on the ticket. Agents and workflows start only once a ticket has a project, and a ticket can change project only while no agent or workflow is active on it.
- *Linear "rejected the API key"*: create a personal API key in Linear → Settings → API and re-enter it in Settings → Task sources.
- *Packaged Electron:* the daemon is started with the system `node` so that the native `better-sqlite3` matches Node's ABI.
