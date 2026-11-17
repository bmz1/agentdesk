# Architecture

## Runtime topology

- **Daemon** (`apps/daemon`) is the only component that owns state and processes. It owns SQLite, agent subprocesses, workflow execution, Jira polling and recovery. It listens on `127.0.0.1` only and writes `~/.agentdesk/daemon.json` (URL, token, pid) for discovery. Only one daemon can run per data directory; this is enforced by `daemon.lock`.
- **Electron main** (`apps/desktop/src/main`) creates the window and exposes a narrow preload bridge (connection info, open http(s) links, reveal path, pick directory). It starts the daemon detached if none is running, and never owns agents.
- **Renderer** is a static Vite SPA. TanStack Router provides file-based routes with typed search params for filters and tabs, TanStack Query holds server state, and Zustand holds transient UI state only.

## Effect service graph

`runtime.ts` composes explicit layers:

```
DaemonConfig + FileLogger
 └─ Database (better-sqlite3, WAL, migrations) · Notices (PubSub)
     └─ EventLog · Activity · CredentialStore
         └─ Projects · Tickets · Approvals · Workspaces · Harnesses · JiraSync · Maintenance
             └─ Sessions
                 └─ Workflows
```

Each service is a `Context.Service` with a `Layer` that has typed errors (`NotFound`, `BadRequest`, `Conflict`, `DbError`, `HarnessError`, `GitError`, `JiraError`). The HTTP layer (`http/app.ts`) only decodes input with Effect Schema, calls a service and maps errors to status codes.

## Harness layer

`HarnessAdapter.start/resume` returns a `HarnessSession` bound to a `Scope`. Closing the scope kills the harness process group. Every adapter normalizes its native protocol into the canonical `AgentEvent` union (`packages/contracts/src/agent-events.ts`):

| Harness | Transport | Approvals | Interrupt | Resume |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --input-format/--output-format stream-json`, stdio | `control_request can_use_tool` (`--permission-prompt-tool stdio`) | control `interrupt` | `--resume <session_id>` |
| Codex | `codex app-server` JSON-RPC over stdio | server requests `item/*/requestApproval` | `turn/interrupt` | `thread/resume` |
| OpenCode | `opencode serve` per session, HTTP + SSE `/event` | `permission.asked` → `/permission/:id/reply` | `/session/:id/abort` | existing session id |

No adapter parses terminal output.

## Event pipeline

```
native protocol → adapter normalizer → AgentEvent
  → redact → Schema-validate → SQLite append (monotonic id) → PubSub
  → SSE GET /sessions/:id/events?after=<id>
```

A subscription registers on the PubSub *before* it reads history, then drops live events whose ids are at or below the last replayed id. That gives replay with no gaps and no duplicates. The client dedupes by id and reconnects from the last id it saw. Coarse change notices go out on `GET /events` and drive TanStack Query invalidation.

## Sessions

The `Sessions` service owns live harness sessions in daemon scopes. A UI disconnect has no effect on them. An ad-hoc session takes the worktree's single-writer lock. Approvals are persisted, routed back to the harness, and expired if the process dies. On startup, sessions left live are marked `interrupted`; orphaned harness processes are terminated after a pid and command check. A follow-up prompt resumes the provider conversation in a new process. **Resuming a conversation does not resume the original process.**

## Workflow durability

A fiber is not a workflow. A run's state lives in `workflow_runs` and `step_runs`:

1. `nextAction(plan, attempts)` is a pure function that decides whether to run, wait, complete or fail.
2. Each attempt is claimed by inserting a `step_run` with a unique idempotency key (`run:step:attempt`) *before* any side effects.
3. Approval gates set the run to `waiting_for_approval` and end the executor fiber, so no scheduler slot is held. The decision re-queues the run.
4. On startup, in-flight runs and steps are marked `interrupted`. Resuming re-runs the interrupted step as a new attempt. PR creation is idempotent because it looks up an existing PR for the branch first.
5. Runs pin `(workflowId, version)`. Definitions are immutable per version.

The scheduler is FIFO with a global cap (`AGENTDESK_MAX_RUNS`, default 3) and a per-project cap (`AGENTDESK_MAX_RUNS_PER_PROJECT`, default 2).

## Data model

See `packages/db/src/schema.ts`. Key separations:
- `tickets.status` is the **local** board column. `ticket_external_links.remote_status` is Jira's status. Neither ever writes to the other.
- External identity (`provider, connection, remote_id`) is separate from the internal UUID.
- `activity_events` is the immutable audit trail and survives transcript retention pruning.
