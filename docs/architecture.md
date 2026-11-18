# Architecture

## Runtime topology

- **Daemon** (`apps/daemon`) is the only component that owns state and processes. It owns SQLite, agent subprocesses, workflow execution, Jira polling and recovery. It listens on `127.0.0.1` only and writes `~/.agentdesk/daemon.json` (URL, token, pid) for discovery. Only one daemon can run per data directory; this is enforced by `daemon.lock`.
- **Electron main** (`apps/desktop/src/main`) creates the window and exposes a narrow preload bridge (connection info, open http(s) links, reveal path, pick directory). It starts the daemon detached if none is running, and never owns agents.
- **Renderer** is a static Vite SPA. TanStack Router provides file-based routes with typed search params for filters and tabs, TanStack Query holds server state, and Zustand holds transient UI state only.

## Effect v4 usage

The daemon is an Effect application end to end; Hono is only the transport.

| Concern | How |
| --- | --- |
| Services | `Context.Service` classes, implementations returned with `Service.of`, wired as `Layer`s (`runtime.ts`). Infrastructure services carry a `static layer`. |
| Composition root | `server.ts` resolves config with `Config`, builds one `ManagedRuntime` from the app `Layer`, and disposes it on shutdown (closing every scope: agent processes, pollers, run executors). |
| HTTP bridge | Each Hono handler is one Effect run on the runtime (`http/respond.ts`): services via `Service.use`, bodies decoded with `Schema`, a server span per route, interruption on client disconnect (`AbortSignal`). |
| Errors | All expected failures are `Schema.TaggedError`s (`NotFound`, `BadRequest`, `Conflict`, `DbError`, `HarnessError`, `GitError`, `PullRequestError`, `JiraError`, `WorkflowValidationError`, `SchemaError`), unioned as `AppError` and mapped to HTTP by an exhaustive `switch` (`toHttpError`): adding an error without a mapping is a compile error. Defects are logged with their `Cause` and become 500s. The workflow engine is fully typed (`StepError`); typed step failures become failed attempts that feed retries. |
| Processes | Agent harnesses and short commands run through `effect/process` (`ChildProcess` + `ChildProcessSpawner`, Node implementation from `@effect/platform-node`): detached process groups, SIGTERM→SIGKILL escalation on scope close. Services capture the spawner in their layer, so their interfaces stay free of it. |
| Concurrency | Session consumers and Jira pollers are supervised in `FiberMap`s. The workflow scheduler admits runs FIFO through a per-project `Semaphore` and then a global one, executors in a `FiberMap` (cancel = remove). Codex prompts flow through a `Queue` drained by a scoped turn-loop fiber; mock turns live in a `FiberHandle` so interrupt is real fiber interruption. |
| Time | All timestamps come from `Clock` (`util.nowIso`); polling and retention are `Schedule`s (Jira backoff via `Schedule.modifyDelay`), so tests drive them with `TestClock`. |
| Config & secrets | `Config.all` over the environment (validated ints/ports, options, defaults); the API token and Jira tokens are `Redacted` across service boundaries. |
| Caching | Harness detection uses `Cache` with a 5 minute TTL. |
| Observability | `Effect.fn("Service.method")` spans with domain attributes (ticketId, runId, stepId, sessionId, harness, outcome, exitCode, prUrl…), a long-lived `AgentSession` span per process, and HTTP/SSE server spans. Exported over OTLP (`effect/observability`) when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; logs go to a redacted JSON-lines file. |
| Testing | `@effect/vitest`: `it.effect` (with `TestClock`), `it.live`, `layer(...)`; the real app `Layer` is built per test on a temp dir (`test/support.ts`); a recording tracer asserts the span tree. |

### Service graph

```
DaemonConfig · NodeServices (ChildProcessSpawner…) · Observability
 └─ Database (better-sqlite3, WAL, migrations) · Notices (PubSub)
     └─ EventLog · Activity · CredentialStore
         └─ Projects · Tickets · Approvals · Workspaces · Harnesses · JiraSync · Maintenance
             └─ Sessions
                 └─ Workflows
```

## Harness layer

`HarnessAdapter.start/resume` returns a `HarnessSession` bound to a `Scope`. Closing the scope kills the harness process group. Every adapter normalizes its native protocol into the canonical `AgentEvent` union (`packages/contracts/src/agent-events.ts`):

| Harness | Transport | Approvals | Interrupt | Resume |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p --input-format/--output-format stream-json`, stdio | `control_request can_use_tool` (`--permission-prompt-tool stdio`) | control `interrupt` | `--resume <session_id>` |
| Codex | `codex app-server` JSON-RPC over stdio | server requests `item/*/requestApproval` | `turn/interrupt` | `thread/resume` |
| OpenCode (2.x) | private `opencode serve --stdio` per session (loopback, fresh password), `@opencode/client/effect` for calls, SSE `/api/event` decoded leniently | `permission.asked` → `permission.reply` on the asking session (a subagent's own) | `session.interrupt` | existing session id, permission rules re-applied |

No adapter parses terminal output.

The bridge normalizes the same features across all three:

| Feature | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Questions (`approval.requested` with `kind: "question"`) | `AskUserQuestion` permission request, answered in `updatedInput.answers` (keyed by question text) | `item/tool/requestUserInput`, answered `{answers: {id: {answers}}}` | `form.created`, one question per field, answered with `session.form.reply` (option values, typed values) |
| Allow for the session (`scope: "session"`) | the request's `permission_suggestions` as `updatedPermissions` | `acceptForSession` (`approved_for_session` on legacy requests) | reply `always` |
| Plan (`plan.updated`) | `TodoWrite`, or `TaskCreate`/`TaskUpdate` | `turn/plan/updated` | the todo tool's input |
| Turn usage | `result.usage`; cost is the change in the cumulative `total_cost_usd` | difference of `thread/tokenUsage/updated` totals; no cost | sum of the turn's `session.step.ended` tokens and cost |
| Rate limits (`rate_limit`) | `rate_limit_event` (5-hour, weekly) | `account/rateLimits/read` + `account/rateLimits/updated` | not reported |
| Plan mode | `--permission-mode plan` | read-only sandbox with approval policy `never` (plan mode is not settable over app-server) | no plan agent in 2.x: edit and shell rules denied (their tools are hidden) |
| Accept edits | `--permission-mode acceptEdits` | read-only sandbox + `on-request`; AgentDesk approves edit requests itself, writing commands still ask | `edit` rule allowed |
| Effort | `--effort` (restart to change) | per turn | model reference `variant`, switched with `session.switchModel` |

Adapters declare these as `HarnessCapabilities` (in `/harnesses/detect`), so the UI explains approximations instead of pretending. Requests a harness sends that AgentDesk does not serve are answered at once with an error (Claude `control_request`s other than `can_use_tool`, unknown Codex server requests) so an agent never waits on them. OpenCode events of types AgentDesk doesn't know are skipped; the typed client's own event stream is not used, because one unknown event type would end it. A Codex interrupt sent before `turn/start` has returned a turn id is held and sent as soon as the id arrives.

`rate_limit` events are account-wide: the `Limits` service keeps the newest per harness (`GET /limits`, pushed as `limits` notices) and they never enter a transcript. Sessions carry `plan` (done/total/current step of the latest `plan.updated`) and `usage` (summed over `turn.completed`; input counts cached reads), loaded from the event log once and then kept current as events are recorded.

## Task sources (Jira, Linear, …)

Ticket sources follow the same adapter pattern as harnesses:

```
packages/task-source        TaskSourceAdapter / TaskSourceClient contract, RemoteTask, TaskSourceError, registry
packages/jira  → jiraSource     JQL-scoped, Cloud + Data Center
packages/linear → linearSource  team-scoped (assignee / state / label filters), GraphQL
apps/daemon  TaskSources (registry service) + TaskSync (generic sync service)
```

An adapter only knows how to **validate its settings** (an Effect Schema), **describe its form** (`fields`, `credential`), **test** a connection and **fetch a page** of `RemoteTask`s (full, or incremental since an instant). Everything else lives once in `TaskSync`: idempotent upserts keyed by `(provider, connection, remoteId)`, the overlapping `updatedAt` watermark, out-of-scope detection on full syncs (tickets are marked `missing`, never deleted), polling with failure backoff (`FiberMap` + `Schedule`), per-connection serialization (`Semaphore`), credentials (`Redacted`, OS store), audit records and change notices. Board status stays local for every source; remote-owned title/description are read-only.

Storage is generic (`source_connections` with validated JSON settings, `source_sync_state`); migration 2 moved existing Jira connections over. The API is `/sources` (descriptors for UIs) and `/sources/connections[/:id[/sync|/test]]`; `/jira/connections` remains as a deprecated alias for one release. The settings UI renders every source's form from its descriptor.

**Adding a source** (e.g. GitHub Issues): create a package exporting a `TaskSourceAdapter` (settings schema, fields, `connect` → `test` + `fetchPage` mapping to `RemoteTask` and failing with `TaskSourceError`), add it to `defaultSources()` in `apps/daemon/src/services/task-sync.ts`, and optionally a display name in the renderer's `sourceLabel`. No schema, API or form changes are needed.

## Event pipeline

```
native protocol → adapter normalizer → AgentEvent
  → redact → Schema-validate → SQLite append (monotonic id) → PubSub
  → SSE GET /sessions/:id/events?after=<id>
```

A subscription registers on the PubSub *before* it reads history, then drops live events whose ids are at or below the last replayed id. That gives replay with no gaps and no duplicates. The client dedupes by id and reconnects from the last id it saw. Change notices go out on `GET /events`. Most are coarse and drive TanStack Query invalidation; a `sessions` notice carries the whole updated session (state, `lastEventId`, `statusDetail`, `preview`), which the renderer writes into every cached list in place (`upsertSession`), so state changes reach the screen without a refetch. The daemon publishes one per state change, status-line change or preview change; streamed tokens only count when they change the line, so streaming stays quiet. After a reconnect the renderer invalidates everything once, because notices sent while disconnected are lost.

Transcripts open end first: the renderer fetches the newest page (`GET /sessions/:id/history?tail=2000`), draws it, then attaches the live stream after its last id. Older pages come from `?tail=2000&before=<id>` and are folded in by rebuilding the transcript from the full event list.

A turn's end is ordered: post-turn work (ready-for-review), then the `turn.completed` event, then the `idle` state, under a per-session lock shared with live prompts. Whoever sees `idle` has already seen the turn end, and a prompt sent in reaction cannot interleave with it.

## Sessions

The `Sessions` service owns live harness sessions in daemon scopes. A UI disconnect has no effect on them. Every session runs in an AgentDesk worktree, never the main checkout. An ad-hoc session takes the worktree's single-writer lock. A worktree whose project setup script has not yet succeeded (`workspaces.setup_state = pending`) runs it first: the session answers `starting` at once and boots in the background, recording the script as a `tool.started`/`tool.completed` pair. A failure fails the session and leaves the worktree pending, and a stop during setup cancels it. Workflow runs run the same script while `preparing`. Approvals are persisted, routed back to the harness, and expired if the process dies. On startup, sessions left live are marked `interrupted`; orphaned harness processes are terminated after a pid and command check. A follow-up prompt resumes the provider conversation in a new process. **Resuming a conversation does not resume the original process.**

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
- `tickets.status` is the **local** board column. `ticket_external_links.remote_status` is the source's status (Jira, Linear, …). Neither ever writes to the other.
- External identity (`provider, connection, remote_id`) is separate from the internal UUID.
- `activity_events` is the immutable audit trail and survives transcript retention pruning.
