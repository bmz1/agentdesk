import type { Approval, ApprovalDecision } from "@agentdesk/contracts"
import { approvals } from "@agentdesk/db"
import { and, desc, eq, isNull } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Database } from "./database"
import { Notices } from "./notices"

type Row = typeof approvals.$inferSelect
export const toApproval = (r: Row): Approval => ({
  id: r.id,
  ticketId: r.ticketId,
  runId: r.runId,
  stepRunId: r.stepRunId,
  sessionId: r.sessionId,
  kind: r.kind as Approval["kind"],
  title: r.title,
  details: r.details ?? null,
  decision: (r.decision as ApprovalDecision | null) ?? null,
  actor: r.actor,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt
})

export interface CreateApprovalInput {
  readonly id?: string
  readonly ticketId: string
  readonly kind: Approval["kind"]
  readonly title: string
  readonly details?: unknown
  readonly runId?: string | null
  readonly stepRunId?: string | null
  readonly sessionId?: string | null
  readonly providerRequestId?: string | null
}

export interface ApprovalsShape {
  readonly create: (input: CreateApprovalInput) => Effect.Effect<Approval & { providerRequestId: string | null }, DbError>
  readonly get: (id: string) => Effect.Effect<Approval & { providerRequestId: string | null }, NotFound | DbError>
  /** Record a decision exactly once. A second decision fails with Conflict. */
  readonly record: (
    id: string,
    decision: ApprovalDecision,
    actor: string,
    note?: string
  ) => Effect.Effect<Approval & { providerRequestId: string | null }, NotFound | Conflict | DbError>
  readonly list: (filter: { pending?: boolean; ticketId?: string; runId?: string }) => Effect.Effect<ReadonlyArray<Approval>, DbError>
  /** Expire pending approvals (e.g. after the owning process died). */
  readonly expireForSession: (sessionId: string) => Effect.Effect<number, DbError>
}

export class Approvals extends Context.Service<Approvals, ApprovalsShape>()("agentdesk/Approvals") {}

export const ApprovalsLive = Layer.effect(
  Approvals,
  Effect.gen(function* () {
    const { use } = yield* Database
    const notices = yield* Notices
    const withProvider = (r: Row) => ({ ...toApproval(r), providerRequestId: r.providerRequestId })

    const get = (id: string) =>
      use((db) => db.select().from(approvals).where(eq(approvals.id, id)).get()).pipe(
        Effect.flatMap((r) => (r ? Effect.succeed(withProvider(r)) : Effect.fail(new NotFound({ entity: "approval", id }))))
      )

    return Approvals.of({
      create: Effect.fn("Approvals.create")(function* (input: CreateApprovalInput) {
          yield* Effect.annotateCurrentSpan({ ticketId: input.ticketId, kind: input.kind, runId: input.runId ?? "", sessionId: input.sessionId ?? "" })
          const createdAt = yield* nowIso
          const row: Row = {
            id: input.id ?? newId(),
            ticketId: input.ticketId,
            runId: input.runId ?? null,
            stepRunId: input.stepRunId ?? null,
            sessionId: input.sessionId ?? null,
            kind: input.kind,
            title: input.title,
            providerRequestId: input.providerRequestId ?? null,
            details: input.details ?? null,
            decision: null,
            actor: null,
            note: null,
            createdAt,
            decidedAt: null
          }
          yield* use((db) => db.insert(approvals).values(row).run())
          yield* notices.publish({ topic: "approvals", ticketId: input.ticketId })
          return withProvider(row)
        }),
      get,
      record: Effect.fn("Approvals.record")(function* (id: string, decision: ApprovalDecision, actor: string, note?: string) {
          yield* Effect.annotateCurrentSpan({ approvalId: id, decision, actor })
          const decidedAt = yield* nowIso
          const changes = yield* use(
            (db) =>
              db
                .update(approvals)
                .set({ decision, actor, note: note ?? null, decidedAt })
                .where(and(eq(approvals.id, id), isNull(approvals.decision)))
                .run().changes
          )
          const a = yield* get(id)
          if (changes === 0) return yield* new Conflict({ message: `Approval already decided (${a.decision})` })
          yield* notices.publish({ topic: "approvals", ticketId: a.ticketId })
          return a
        }),
      list: (filter) =>
        use((db) =>
          db
            .select()
            .from(approvals)
            .where(
              and(
                filter.pending ? isNull(approvals.decision) : undefined,
                filter.ticketId ? eq(approvals.ticketId, filter.ticketId) : undefined,
                filter.runId ? eq(approvals.runId, filter.runId) : undefined
              )
            )
            .orderBy(desc(approvals.createdAt))
            .limit(500)
            .all()
            .map(toApproval)
        ),
      expireForSession: (sessionId) =>
        Effect.flatMap(nowIso, (decidedAt) => use(
          (db) =>
            db
              .update(approvals)
              .set({ decision: "deny", actor: "system", note: "Expired: agent process ended", decidedAt })
              .where(and(eq(approvals.sessionId, sessionId), isNull(approvals.decision)))
              .run().changes
        ))
    })
  })
)
