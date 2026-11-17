import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import type { Diff, Project, Workspace } from "@agentdesk/contracts"
import { projects, workspaces } from "@agentdesk/db"
import * as Git from "@agentdesk/git"
import { and, desc, eq, isNull, or } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { DaemonConfig } from "../config"
import { BadRequest, Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso, shortId } from "../util"
import { Activity } from "./activity"
import { Database } from "./database"

type Row = typeof workspaces.$inferSelect
const toWorkspace = (r: Row): Workspace => ({
  id: r.id,
  projectId: r.projectId,
  runId: r.runId,
  branch: r.branch,
  path: r.path,
  baseCommit: r.baseCommit,
  cleanupState: r.cleanupState as Workspace["cleanupState"],
  createdAt: r.createdAt
})

export interface AllocateInput {
  readonly project: Project
  readonly ticketId: string
  readonly ticketIdentifier: string
  readonly ticketTitle: string
  readonly runId?: string
}

/** Canonical form for comparing worktree paths (macOS /var → /private/var, trailing slashes). */
export const canonicalPath = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p.replace(/\/+$/, "")
  }
}

export interface AdoptInput {
  readonly project: Project
  readonly ticketId: string
  /** A linked worktree of the project repo that an agent created itself. */
  readonly worktree: Git.WorktreeEntry
}

export interface WorkspacesShape {
  /** Create a dedicated git worktree + branch for a ticket/run. */
  readonly allocate: (input: AllocateInput) => Effect.Effect<Workspace, Git.GitError | BadRequest | DbError>
  /** Reuse the ticket's most recent active (non-run) workspace, or allocate a new one. */
  readonly forTicket: (input: AllocateInput) => Effect.Effect<Workspace, Git.GitError | BadRequest | DbError>
  /** Register a worktree the agent created itself, so diff, review, cleanup and PRs see it. */
  readonly adopt: (input: AdoptInput) => Effect.Effect<Workspace, Git.GitError | DbError>
  /** Canonical paths of every worktree AgentDesk already knows about for a project (any state). */
  readonly registeredPaths: (projectId: string) => Effect.Effect<ReadonlySet<string>, DbError>
  readonly get: (id: string) => Effect.Effect<Workspace, NotFound | DbError>
  readonly latestForTicket: (ticketId: string) => Effect.Effect<Workspace | undefined, DbError>
  /** Exclusive single-writer lock. Fails with Conflict if held by someone else. */
  readonly lock: (id: string, holder: string) => Effect.Effect<void, Conflict | DbError>
  readonly unlock: (id: string, holder: string) => Effect.Effect<void, DbError>
  readonly diff: (id: string) => Effect.Effect<Diff, NotFound | Git.GitError | DbError>
  /**
   * Remove the worktree. Refuses when it has uncommitted changes unless `force`.
   * The branch is kept so committed work is never lost.
   */
  readonly cleanup: (id: string, force?: boolean) => Effect.Effect<Workspace, NotFound | Conflict | Git.GitError | DbError>
}

export class Workspaces extends Context.Service<Workspaces, WorkspacesShape>()("agentdesk/Workspaces") {}

export const WorkspacesLive = Layer.effect(
  Workspaces,
  Effect.gen(function* () {
    const config = yield* DaemonConfig
    const database = yield* Database
    const { use } = database
    const activity = yield* Activity
    const withProcesses = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner)
    const projectRepo = (projectId: string) =>
      use(
        (db) => db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId)).get()?.repoPath
      )

    const get = (id: string) =>
      use((db) => db.select().from(workspaces).where(eq(workspaces.id, id)).get()).pipe(
        Effect.flatMap((r) => (r ? Effect.succeed(toWorkspace(r)) : Effect.fail(new NotFound({ entity: "workspace", id }))))
      )

    const allocate = Effect.fn("Workspaces.allocate")(function* (input: AllocateInput) {
        const { project } = input
        yield* Effect.annotateCurrentSpan({ ticketId: input.ticketId, runId: input.runId ?? "", projectId: project.id })
        if (!(yield* Git.isRepository(project.repoPath))) {
          return yield* new BadRequest({ message: `Project repository is missing: ${project.repoPath}` })
        }
        const id = newId()
        const sid = shortId(id)
        const branch = `agentdesk/${Git.slugify(input.ticketIdentifier, 20)}-${Git.slugify(input.ticketTitle, 30)}-${sid}`
        const dir = join(config.worktreesDir, project.key.toLowerCase())
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `${Git.slugify(input.ticketIdentifier, 20)}-${sid}`)
        const base = yield* Git.revParse(project.repoPath, project.defaultBranch).pipe(
          Effect.catch(() => Git.revParse(project.repoPath, "HEAD"))
        )
        yield* Git.worktreeAdd(project.repoPath, path, branch, base)
        const row: Row = {
          id,
          projectId: project.id,
          runId: input.runId ?? null,
          ticketId: input.ticketId,
          branch,
          path,
          baseCommit: base,
          cleanupState: "active",
          lockedBy: null,
          createdAt: yield* nowIso
        }
        yield* use((db) => db.insert(workspaces).values(row).run())
        yield* Effect.annotateCurrentSpan({ branch, workspaceId: id })
        yield* activity.record({
          kind: "workspace.created",
          message: `Worktree created on branch ${branch}`,
          ticketId: input.ticketId,
          runId: input.runId ?? null,
          data: { path, branch, baseCommit: base }
        })
        return toWorkspace(row)
      }, withProcesses)

    const adopt = Effect.fn("Workspaces.adopt")(function* ({ project, ticketId, worktree }: AdoptInput) {
        yield* Effect.annotateCurrentSpan({ ticketId, projectId: project.id, path: worktree.path })
        const head = worktree.head ?? (yield* Git.revParse(worktree.path, "HEAD"))
        // Diff against where the agent's branch left the default branch, not the default branch's tip.
        const baseCommit = yield* Git.git(worktree.path, ["merge-base", "HEAD", project.defaultBranch]).pipe(
          Effect.map((s) => s.trim()),
          Effect.orElseSucceed(() => head)
        )
        const row: Row = {
          id: newId(),
          projectId: project.id,
          runId: null,
          ticketId,
          branch: worktree.branch ?? head,
          path: canonicalPath(worktree.path),
          baseCommit,
          cleanupState: "active",
          lockedBy: null,
          createdAt: yield* nowIso
        }
        yield* use((db) => db.insert(workspaces).values(row).run())
        yield* activity.record({
          kind: "workspace.adopted",
          message: `Agent created worktree on ${worktree.branch ? `branch ${worktree.branch}` : "a detached HEAD"}; now tracking it`,
          ticketId,
          data: { path: row.path, branch: row.branch, baseCommit }
        })
        return toWorkspace(row)
      }, withProcesses)

    const registeredPaths = (projectId: string) =>
      use((db) => db.select({ path: workspaces.path }).from(workspaces).where(eq(workspaces.projectId, projectId)).all()).pipe(
        Effect.map((rows) => new Set(rows.map((r) => canonicalPath(r.path))))
      )

    const latestRow = (ticketId: string) =>
      use((db) =>
        db
          .select()
          .from(workspaces)
          .where(and(eq(workspaces.ticketId, ticketId), eq(workspaces.cleanupState, "active")))
          .orderBy(desc(workspaces.createdAt))
          .limit(1)
          .get()
      )

    const forTicket = Effect.fn("Workspaces.forTicket")(function* (input: AllocateInput) {
        const existing = yield* latestRow(input.ticketId)
        if (existing && !existing.lockedBy && existsSync(existing.path)) return toWorkspace(existing)
        return yield* allocate(input)
      })

    const lock = (id: string, holder: string) =>
      use((db) =>
        db
          .update(workspaces)
          .set({ lockedBy: holder })
          .where(and(eq(workspaces.id, id), or(isNull(workspaces.lockedBy), eq(workspaces.lockedBy, holder))))
          .run().changes
      ).pipe(
        Effect.flatMap((changes) =>
          changes === 1 ? Effect.void : Effect.fail(new Conflict({ message: "Workspace already has an active writer" }))
        )
      )

    const unlock = (id: string, holder: string) =>
      use((db) =>
        db
          .update(workspaces)
          .set({ lockedBy: null })
          .where(and(eq(workspaces.id, id), eq(workspaces.lockedBy, holder)))
          .run()
      ).pipe(Effect.asVoid)

    const diff = Effect.fn("Workspaces.diff")(function* (id: string) {
        yield* Effect.annotateCurrentSpan({ workspaceId: id })
        const ws = yield* get(id)
        if (!existsSync(ws.path)) {
          // Worktree removed: fall back to the branch in the main repo.
          const row = yield* use((db) => db.select().from(workspaces).where(eq(workspaces.id, id)).get())
          const repo = row ? yield* projectRepo(row.projectId) : undefined
          if (!repo) return yield* new NotFound({ entity: "worktree", id })
          return yield* Git.git(repo, ["diff", "--no-color", `${ws.baseCommit}...${ws.branch}`]).pipe(
            Effect.map(
              (patch): Diff => ({ branch: ws.branch, baseCommit: ws.baseCommit, headCommit: null, files: [], patch, commits: [] })
            )
          )
        }
        return yield* Git.diffAgainst(ws.path, ws.baseCommit)
      }, withProcesses)

    const cleanup = Effect.fn("Workspaces.cleanup")(function* (id: string, force = false) {
        yield* Effect.annotateCurrentSpan({ workspaceId: id, force })
        const ws = yield* get(id)
        if (ws.cleanupState === "removed") return ws
        const row = yield* use((db) => db.select().from(workspaces).where(eq(workspaces.id, id)).get())
        if (row?.lockedBy) return yield* new Conflict({ message: "Workspace is in use by an active session or run" })
        if (existsSync(ws.path)) {
          if (!force && !(yield* Git.isClean(ws.path))) {
            return yield* new Conflict({ message: "Worktree has uncommitted changes; commit them or force cleanup" })
          }
          const repo = yield* projectRepo(ws.projectId)
          if (repo) yield* Git.worktreeRemove(repo, ws.path, force)
        }
        yield* use((db) => db.update(workspaces).set({ cleanupState: "removed" }).where(eq(workspaces.id, id)).run())
        yield* activity.record({
          kind: "workspace.removed",
          message: `Worktree removed (branch ${ws.branch} kept)`,
          ticketId: row?.ticketId ?? null,
          runId: ws.runId
        })
        return { ...ws, cleanupState: "removed" as const }
      }, withProcesses)

    return Workspaces.of({
      allocate,
      forTicket,
      adopt,
      registeredPaths,
      get,
      latestForTicket: (ticketId) => latestRow(ticketId).pipe(Effect.map((r) => (r ? toWorkspace(r) : undefined))),
      lock,
      unlock,
      diff,
      cleanup
    })
  })
)
