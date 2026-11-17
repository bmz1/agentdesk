import {
  UpdateHarnessSettingsBody,
  ApprovalDecisionBody,
  type BoardStatus,
  CreateJiraConnectionBody,
  CreateSourceConnectionBody,
  type SourceConnection,
  UpdateSourceConnectionBody,
  CreateProjectBody,
  CreateTicketBody,
  PromptBody,
  UploadAttachmentBody,
  SaveWorkflowBody,
  StartRunBody,
  StartSessionBody,
  type TicketSource,
  UpdateJiraConnectionBody,
  UpdateProjectBody,
  UpdateTicketBody
} from "@agentdesk/contracts"
import { redactSecrets } from "@agentdesk/harness-core"
import { Effect, Stream } from "effect"
import { Hono } from "hono"
import { DaemonConfig, type DaemonConfigShape } from "../config"
import type { AppRuntime } from "../runtime"
import { Activity } from "../services/activity"
import { Approvals } from "../services/approvals"
import { Attachments } from "../services/attachments"
import { listTicketFiles, readTicketFile, readTicketImage } from "../services/files"
import { EventLog } from "../services/event-log"
import { HarnessSettings } from "../services/harness-settings"
import { Harnesses } from "../services/harnesses"
import { TaskSync } from "../services/task-sync"
import { Notices } from "../services/notices"
import { Projects } from "../services/projects"
import { Sessions } from "../services/sessions"
import { Tickets } from "../services/tickets"
import { Workflows } from "../services/workflows"
import { Workspaces } from "../services/workspaces"
import { body, makeResponder, RawBody } from "./respond"
import { securityMiddleware } from "./security"
import { sseFromStream } from "./sse"

/**
 * Thin Hono transport. Every handler is a single Effect run on the daemon's
 * ManagedRuntime; services are reached with `Service.use`, bodies are decoded
 * with Effect Schema, and failures stay typed until `respond` maps them.
 */
export const makeApp = (runtime: AppRuntime, config: DaemonConfigShape) => {
  const app = new Hono()
  const respond = makeResponder(runtime)
  const startedAt = new Date().toISOString()
  const id = (c: { req: { param: (k: string) => string } }) => c.req.param("id")

  app.use("*", securityMiddleware(config))
  app.get("/health", (c) => c.json({ ok: true, version: config.version }))

  app.get("/info", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        const cfg = yield* DaemonConfig
        return {
          version: cfg.version,
          pid: process.pid,
          startedAt,
          dataDir: cfg.dataDir,
          persistent: cfg.persistent,
          activeSessions: (yield* Sessions).liveCount(),
          activeRuns: (yield* Workflows).activeCount()
        }
      })
    )
  )

  // ---- live invalidation notices -------------------------------------------------
  app.get("/events", (c) =>
    sseFromStream(c, runtime, Stream.unwrap(Notices.use((n) => Effect.succeed(n.stream))), (n) => ({
      event: "notice",
      data: JSON.stringify(n)
    }))
  )

  app.get("/settings/harnesses", (c) => respond(c, HarnessSettings.use((s) => s.get)))
  app.patch("/settings/harnesses", (c) => respond(c,
    body(c, UpdateHarnessSettingsBody).pipe(Effect.flatMap((b) => HarnessSettings.use((s) => s.update(b))))
  ))

  // ---- projects --------------------------------------------------------------------
  app.get("/projects", (c) => respond(c, Projects.use((p) => p.list)))
  app.post("/projects", (c) =>
    respond(c, body(c, CreateProjectBody).pipe(Effect.flatMap((b) => Projects.use((p) => p.create(b)))), 201)
  )
  app.get("/projects/:id", (c) => respond(c, Projects.use((p) => p.get(id(c)))))
  app.patch("/projects/:id", (c) =>
    respond(c, body(c, UpdateProjectBody).pipe(Effect.flatMap((b) => Projects.use((p) => p.update(id(c), b)))))
  )
  app.delete("/projects/:id", (c) => respond(c, Projects.use((p) => p.remove(id(c)))))

  // ---- tickets ---------------------------------------------------------------------
  app.get("/tickets", (c) => {
    const q = c.req.query()
    return respond(
      c,
      Tickets.use((t) =>
        t.list({
          projectId: q.projectId || undefined,
          source: (q.source as TicketSource) || undefined,
          status: (q.status as BoardStatus) || undefined,
          q: q.q || undefined,
          pinned: q.pinned === "1" ? true : undefined
        })
      )
    )
  })
  app.post("/tickets", (c) => respond(c, body(c, CreateTicketBody).pipe(Effect.flatMap((b) => Tickets.use((t) => t.create(b)))), 201))
  app.get("/tickets/:id", (c) => respond(c, Tickets.use((t) => t.get(id(c)))))
  app.patch("/tickets/:id", (c) =>
    respond(c, body(c, UpdateTicketBody).pipe(Effect.flatMap((b) => Tickets.use((t) => t.update(id(c), b)))))
  )
  app.delete("/tickets/:id", (c) => respond(c, Tickets.use((t) => t.remove(id(c)))))
  app.get("/tickets/:id/activity", (c) => respond(c, Activity.use((a) => a.list({ ticketId: id(c), limit: 300 }))))
  app.get("/tickets/:id/sessions", (c) => respond(c, Sessions.use((s) => s.list({ ticketId: id(c) }))))
  app.post("/tickets/:id/sessions", (c) =>
    respond(c, body(c, StartSessionBody).pipe(Effect.flatMap((b) => Sessions.use((s) => s.startForTicket(id(c), b)))), 201)
  )
  app.get("/tickets/:id/approvals", (c) => respond(c, Approvals.use((a) => a.list({ ticketId: id(c) }))))
  app.get("/tickets/:id/diff", (c) =>
    respond(
      c,
      Workspaces.use((w) =>
        Effect.gen(function* () {
          const ws = yield* w.latestForTicket(id(c))
          if (!ws) return { branch: null, baseCommit: null, headCommit: null, files: [], patch: "", commits: [] }
          const diff = yield* w.diff(ws.id)
          return { ...diff, patch: redactSecrets(diff.patch) }
        })
      )
    )
  )
  app.post("/attachments", (c) =>
    respond(
      c,
      body(c, UploadAttachmentBody).pipe(
        Effect.flatMap((b) => Attachments.use((a) => a.save(Buffer.from(b.data, "base64"), b.mimeType, b.name)))
      ),
      201
    )
  )
  app.get("/attachments/:id", (c) =>
    respond(c, Attachments.use((a) => a.read(id(c))).pipe(Effect.map((a) => new RawBody(a.bytes, a.mimeType))))
  )
  app.get("/tickets/:id/raw", (c) =>
    respond(c, readTicketImage(id(c), c.req.query("path") ?? "").pipe(Effect.map((f) => new RawBody(f.bytes, f.mimeType, "no-store"))))
  )
  app.get("/tickets/:id/files", (c) => respond(c, listTicketFiles(id(c))))
  app.get("/tickets/:id/file", (c) => respond(c, readTicketFile(id(c), c.req.query("path") ?? "")))
  app.get("/tickets/:id/workspace", (c) =>
    respond(c, Workspaces.use((w) => w.latestForTicket(id(c)).pipe(Effect.map((ws) => ws ?? null))))
  )
  app.post("/workspaces/:id/cleanup", (c) =>
    respond(c, Workspaces.use((w) => w.cleanup(id(c), c.req.query("force") === "1")))
  )

  // ---- sessions --------------------------------------------------------------------
  app.get("/sessions", (c) => respond(c, Sessions.use((s) => s.list({ active: c.req.query("active") === "1", limit: 100 }))))
  app.get("/sessions/:id", (c) => respond(c, Sessions.use((s) => s.get(id(c)))))
  app.get("/sessions/:id/preview", (c) => respond(c, EventLog.use((e) => e.preview(id(c)))))
  app.get("/sessions/:id/history", (c) =>
    respond(c, EventLog.use((e) => e.history(id(c), { after: Number(c.req.query("after") ?? 0) || 0, limit: 5000 })))
  )
  app.get("/sessions/:id/events", (c) => {
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0) || 0
    const sessionId = id(c)
    return sseFromStream(
      c,
      runtime,
      Stream.unwrap(EventLog.use((e) => Effect.succeed(e.subscribe(sessionId, after)))),
      (e) => ({ id: String(e.id), event: "agent", data: JSON.stringify(e) })
    )
  })
  app.post("/sessions/:id/prompt", (c) =>
    respond(c, body(c, PromptBody).pipe(Effect.flatMap((b) => Sessions.use((s) => s.prompt(id(c), b.text, "user", b.images)))))
  )
  app.post("/sessions/:id/interrupt", (c) => respond(c, Sessions.use((s) => s.interrupt(id(c)))))
  app.post("/sessions/:id/stop", (c) => respond(c, Sessions.use((s) => s.stop(id(c)))))

  // ---- approvals -------------------------------------------------------------------
  app.get("/approvals", (c) => respond(c, Approvals.use((a) => a.list({ pending: c.req.query("pending") === "1" }))))
  app.post("/approvals/:id/decision", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        const b = yield* body(c, ApprovalDecisionBody)
        const approval = yield* Approvals.use((a) => a.get(id(c)))
        // Tool approvals go back to the agent harness; workflow gates resume the run.
        if (approval.kind === "tool") return yield* Sessions.use((s) => s.resolveApproval(approval.id, b.decision, "user", b.note))
        return yield* Workflows.use((w) => w.resolveApproval(approval.id, b.decision, "user", b.note))
      })
    )
  )

  // ---- task sources (read-only sync: Jira, Linear, …) ------------------------------------
  app.get("/sources", (c) => respond(c, TaskSync.use((t) => Effect.succeed(t.sources))))
  app.get("/sources/connections", (c) => respond(c, TaskSync.use((t) => t.list)))
  app.post("/sources/connections", (c) =>
    respond(c, body(c, CreateSourceConnectionBody).pipe(Effect.flatMap((b) => TaskSync.use((t) => t.create(b)))), 201)
  )
  app.get("/sources/connections/:id", (c) => respond(c, TaskSync.use((t) => t.get(id(c)))))
  app.patch("/sources/connections/:id", (c) =>
    respond(c, body(c, UpdateSourceConnectionBody).pipe(Effect.flatMap((b) => TaskSync.use((t) => t.update(id(c), b)))))
  )
  app.delete("/sources/connections/:id", (c) => respond(c, TaskSync.use((t) => t.remove(id(c)))))
  app.post("/sources/connections/:id/sync", (c) =>
    respond(c, TaskSync.use((t) => t.sync(id(c), { full: c.req.query("full") === "1" })))
  )
  app.post("/sources/connections/:id/test", (c) => respond(c, TaskSync.use((t) => t.test(id(c)))))

  // ---- deprecated /jira/* aliases (one release), translated to the generic API --------------
  const asLegacyJira = (s: SourceConnection) => {
    const settings = s.settings as { deployment: string; baseUrl: string; principal: string; jql: string }
    const { settings: _settings, provider: _provider, ...rest } = s
    return { ...rest, ...settings }
  }
  app.get("/jira/connections", (c) =>
    respond(c, TaskSync.use((t) => t.list.pipe(Effect.map((all) => all.filter((x) => x.provider === "jira").map(asLegacyJira)))))
  )
  app.post("/jira/connections", (c) =>
    respond(
      c,
      body(c, CreateJiraConnectionBody).pipe(
        Effect.flatMap(({ deployment, baseUrl, principal, jql, ...rest }) =>
          TaskSync.use((t) => t.create({ ...rest, provider: "jira", settings: { deployment, baseUrl, principal, jql } }))
        ),
        Effect.map(asLegacyJira)
      ),
      201
    )
  )
  app.patch("/jira/connections/:id", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        const { jql, principal, ...rest } = yield* body(c, UpdateJiraConnectionBody)
        const sync = yield* TaskSync
        const current = yield* sync.get(id(c))
        const settings =
          jql !== undefined || principal !== undefined
            ? { ...(current.settings as object), ...(jql !== undefined && { jql }), ...(principal !== undefined && { principal }) }
            : undefined
        return asLegacyJira(yield* sync.update(id(c), { ...rest, ...(settings && { settings }) }))
      })
    )
  )
  app.delete("/jira/connections/:id", (c) => respond(c, TaskSync.use((t) => t.remove(id(c)))))
  app.post("/jira/connections/:id/sync", (c) => respond(c, TaskSync.use((t) => t.sync(id(c), { full: c.req.query("full") === "1" }))))
  app.post("/jira/connections/:id/test", (c) => respond(c, TaskSync.use((t) => t.test(id(c)))))

  // ---- workflows ---------------------------------------------------------------------
  app.get("/workflows", (c) => respond(c, Workflows.use((w) => w.definitions)))
  app.post("/workflows", (c) => respond(c, body(c, SaveWorkflowBody).pipe(Effect.flatMap((b) => Workflows.use((w) => w.save(b.yaml)))), 201))
  app.post("/workflows/validate", (c) =>
    respond(c, body(c, SaveWorkflowBody).pipe(Effect.flatMap((b) => Workflows.use((w) => w.validate(b.yaml)))))
  )
  app.get("/workflows/:id", (c) => respond(c, Workflows.use((w) => w.definition(id(c)))))
  app.post("/tickets/:id/start-run", (c) =>
    respond(c, body(c, StartRunBody).pipe(Effect.flatMap((b) => Workflows.use((w) => w.start(id(c), b)))), 201)
  )
  app.get("/tickets/:id/runs", (c) => respond(c, Workflows.use((w) => w.list({ ticketId: id(c) }))))
  app.get("/runs", (c) => respond(c, Workflows.use((w) => w.list({ status: c.req.query("status") || undefined }))))
  app.get("/runs/:id", (c) => respond(c, Workflows.use((w) => w.get(id(c)))))
  app.post("/runs/:id/cancel", (c) => respond(c, Workflows.use((w) => w.cancel(id(c)))))
  app.post("/runs/:id/resume", (c) => respond(c, Workflows.use((w) => w.resume(id(c)))))
  app.post("/runs/:id/retry", (c) => respond(c, Workflows.use((w) => w.retry(id(c)))))
  app.get("/artifacts/:id", (c) => respond(c, Workflows.use((w) => w.artifact(id(c)))))

  // ---- misc ------------------------------------------------------------------------
  app.get("/harnesses/detect", (c) => respond(c, Harnesses.use((h) => h.detect(c.req.query("refresh") === "1"))))
  app.get("/activity", (c) => respond(c, Activity.use((a) => a.list({ limit: Number(c.req.query("limit") ?? 100) }))))

  app.notFound((c) => c.json({ error: "NotFound", message: `No route for ${c.req.method} ${c.req.path}` }, 404))
  app.onError((err, c) => c.json({ error: "InternalError", message: err.message }, 500))
  return app
}
