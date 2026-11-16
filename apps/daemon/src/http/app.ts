import {
  ApprovalDecisionBody,
  CreateProjectBody,
  CreateTicketBody,
  PromptBody,
  StartSessionBody,
  UpdateProjectBody,
  UpdateTicketBody,
  type BoardStatus,
  type TicketSource
} from "@agentdesk/contracts"
import { type Context, Effect, Stream } from "effect"
import { Hono } from "hono"
import { DaemonConfig, type DaemonConfigShape } from "../config"
import { BadRequest } from "../errors"
import type { AppRuntime } from "../runtime"
import { Activity } from "../services/activity"
import { Approvals } from "../services/approvals"
import { EventLog } from "../services/event-log"
import { Harnesses } from "../services/harnesses"
import { Notices } from "../services/notices"
import { Projects } from "../services/projects"
import { Sessions } from "../services/sessions"
import { Tickets } from "../services/tickets"
import { Workspaces } from "../services/workspaces"
import { body, makeResponder } from "./respond"
import { securityMiddleware } from "./security"
import { sseFromStream } from "./sse"

const streamUnwrap = Stream.unwrap

/** Access a service and continue with an effect using it. */
export const withSvc = <I, S, A, E, R>(tag: Context.Service<I, S>, f: (s: S) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const s = yield* tag
    return yield* f(s)
  })
export const mapSvc = <I, S, A>(tag: Context.Service<I, S>, f: (s: S) => A) =>
  Effect.gen(function* () {
    return f(yield* tag)
  })

export type RouteRegistrar = (app: Hono, ctx: RouteContext) => void
export interface RouteContext {
  readonly runtime: AppRuntime
  readonly respond: ReturnType<typeof makeResponder>
}

export const makeApp = (runtime: AppRuntime, config: DaemonConfigShape, extraRoutes: ReadonlyArray<RouteRegistrar> = []) => {
  const app = new Hono()
  const respond = makeResponder(runtime)
  const startedAt = new Date().toISOString()

  app.use("*", securityMiddleware(config))

  app.get("/health", (c) => c.json({ ok: true, version: config.version }))

  app.get("/info", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        const cfg = yield* DaemonConfig
        const sessions = yield* Sessions
        return {
          version: cfg.version,
          pid: process.pid,
          startedAt,
          dataDir: cfg.dataDir,
          persistent: cfg.persistent,
          activeSessions: sessions.liveCount(),
          activeRuns: 0
        }
      })
    )
  )

  // ---- live invalidation notices -------------------------------------------------
  app.get("/events", (c) =>
    sseFromStream(
      c,
      runtime,
      streamUnwrap(mapSvc(Notices, (n) => n.stream)),
      (n) => ({ event: "notice", data: JSON.stringify(n) })
    )
  )

  // ---- projects --------------------------------------------------------------------
  app.get("/projects", (c) => respond(c, withSvc(Projects, (p) => p.list)))
  app.post("/projects", async (c) => {
    const input = await body(c, CreateProjectBody)
    return respond(c, Effect.flatMap(input, (b) => withSvc(Projects, (p) => p.create(b))), 201)
  })
  app.get("/projects/:id", (c) => respond(c, withSvc(Projects, (p) => p.get(c.req.param("id")))))
  app.patch("/projects/:id", async (c) => {
    const input = await body(c, UpdateProjectBody)
    return respond(c, Effect.flatMap(input, (b) => withSvc(Projects, (p) => p.update(c.req.param("id"), b))))
  })
  app.delete("/projects/:id", (c) => respond(c, withSvc(Projects, (p) => p.remove(c.req.param("id")))))

  // ---- tickets ---------------------------------------------------------------------
  app.get("/tickets", (c) => {
    const q = c.req.query()
    return respond(
      c,
      withSvc(Tickets, (t) =>
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
  app.post("/tickets", async (c) => {
    const input = await body(c, CreateTicketBody)
    return respond(c, Effect.flatMap(input, (b) => withSvc(Tickets, (t) => t.create(b))), 201)
  })
  app.get("/tickets/:id", (c) => respond(c, withSvc(Tickets, (t) => t.get(c.req.param("id")))))
  app.patch("/tickets/:id", async (c) => {
    const input = await body(c, UpdateTicketBody)
    return respond(c, Effect.flatMap(input, (b) => withSvc(Tickets, (t) => t.update(c.req.param("id"), b))))
  })
  app.delete("/tickets/:id", (c) => respond(c, withSvc(Tickets, (t) => t.remove(c.req.param("id")))))
  app.get("/tickets/:id/activity", (c) =>
    respond(c, withSvc(Activity, (a) => a.list({ ticketId: c.req.param("id"), limit: 300 })))
  )
  app.get("/tickets/:id/sessions", (c) =>
    respond(c, withSvc(Sessions, (s) => s.list({ ticketId: c.req.param("id") })))
  )
  app.post("/tickets/:id/sessions", async (c) => {
    const input = await body(c, StartSessionBody)
    return respond(
      c,
      Effect.flatMap(input, (b) => withSvc(Sessions, (s) => s.startForTicket(c.req.param("id"), b))),
      201
    )
  })
  app.get("/tickets/:id/approvals", (c) =>
    respond(c, withSvc(Approvals, (a) => a.list({ ticketId: c.req.param("id") })))
  )
  app.get("/tickets/:id/diff", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        const ws = yield* (yield* Workspaces).latestForTicket(c.req.param("id"))
        if (!ws) return { branch: null, baseCommit: null, headCommit: null, files: [], patch: "", commits: [] }
        return yield* (yield* Workspaces).diff(ws.id)
      })
    )
  )
  app.get("/tickets/:id/workspace", (c) =>
    respond(
      c,
      Effect.gen(function* () {
        return (yield* (yield* Workspaces).latestForTicket(c.req.param("id"))) ?? null
      })
    )
  )
  app.post("/workspaces/:id/cleanup", (c) =>
    respond(
      c,
      withSvc(Workspaces, (w) => w.cleanup(c.req.param("id"), c.req.query("force") === "1"))
    )
  )

  // ---- sessions --------------------------------------------------------------------
  app.get("/sessions", (c) =>
    respond(c, withSvc(Sessions, (s) => s.list({ active: c.req.query("active") === "1", limit: 100 })))
  )
  app.get("/sessions/:id", (c) => respond(c, withSvc(Sessions, (s) => s.get(c.req.param("id")))))
  app.get("/sessions/:id/history", (c) =>
    respond(
      c,
      withSvc(EventLog, (e) =>
        e.history(c.req.param("id"), { after: Number(c.req.query("after") ?? 0) || 0, limit: 5000 })
      )
    )
  )
  app.get("/sessions/:id/events", (c) => {
    const after = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? 0) || 0
    const id = c.req.param("id")
    return sseFromStream(
      c,
      runtime,
      streamUnwrap(mapSvc(EventLog, (e) => e.subscribe(id, after))),
      (e) => ({ id: String(e.id), event: "agent", data: JSON.stringify(e) })
    )
  })
  app.post("/sessions/:id/prompt", async (c) => {
    const input = await body(c, PromptBody)
    return respond(
      c,
      Effect.flatMap(input, (b) => withSvc(Sessions, (s) => s.prompt(c.req.param("id"), b.text)))
    )
  })
  app.post("/sessions/:id/interrupt", (c) =>
    respond(c, withSvc(Sessions, (s) => s.interrupt(c.req.param("id"))))
  )
  app.post("/sessions/:id/stop", (c) => respond(c, withSvc(Sessions, (s) => s.stop(c.req.param("id")))))

  // ---- approvals -------------------------------------------------------------------
  app.get("/approvals", (c) =>
    respond(c, withSvc(Approvals, (a) => a.list({ pending: c.req.query("pending") === "1" })))
  )

  // ---- misc ------------------------------------------------------------------------
  app.get("/harnesses/detect", (c) =>
    respond(c, withSvc(Harnesses, (h) => h.detect(c.req.query("refresh") === "1")))
  )
  app.get("/activity", (c) =>
    respond(c, withSvc(Activity, (a) => a.list({ limit: Number(c.req.query("limit") ?? 100) })))
  )

  for (const register of extraRoutes) register(app, { runtime, respond })

  // Default approval decision route; workflow-aware routing is registered by extraRoutes when present.
  app.post("/approvals/:id/decision", async (c) => {
    const input = await body(c, ApprovalDecisionBody)
    return respond(
      c,
      Effect.flatMap(input, (b) =>
        withSvc(Sessions, (s) => s.resolveApproval(c.req.param("id"), b.decision, "user", b.note))
      )
    )
  })

  app.notFound((c) => c.json({ error: "NotFound", message: `No route for ${c.req.method} ${c.req.path}` }, 404))
  app.onError((err, c) => c.json({ error: "InternalError", message: err.message }, 500))
  void BadRequest
  return app
}

