import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { CreateProjectBody, Project, UpdateProjectBody } from "@agentdesk/contracts"
import { projects, tickets } from "@agentdesk/db"
import * as Git from "@agentdesk/git"
import { asc, count, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { BadRequest, Conflict, type DbError, NotFound } from "../errors"
import { newId, nowIso } from "../util"
import { Activity } from "./activity"
import { Database } from "./database"
import { HarnessSettings } from "./harness-settings"
import { Notices } from "./notices"

type ProjectRow = typeof projects.$inferSelect

export const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  key: r.key,
  name: r.name,
  repoPath: r.repoPath,
  defaultBranch: r.defaultBranch,
  gitProvider: r.gitProvider as Project["gitProvider"],
  defaultHarness: r.defaultHarness as Project["defaultHarness"],
  defaultWorkflowId: r.defaultWorkflowId,
  permissionMode: r.permissionMode as Project["permissionMode"],
  inheritHarnessPermissions: r.inheritHarnessPermissions,
  testCommand: r.testCommand,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt
})

export interface ProjectsShape {
  readonly list: Effect.Effect<ReadonlyArray<Project>, DbError>
  readonly get: (id: string) => Effect.Effect<Project, NotFound | DbError>
  readonly create: (body: CreateProjectBody) => Effect.Effect<Project, BadRequest | Conflict | DbError>
  readonly update: (id: string, body: UpdateProjectBody) => Effect.Effect<Project, NotFound | BadRequest | DbError>
  readonly remove: (id: string) => Effect.Effect<void, NotFound | Conflict | DbError>
}

export class Projects extends Context.Service<Projects, ProjectsShape>()("agentdesk/Projects") {}

export const deriveKey = (name: string) => {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean)
  const key = words.length > 1 ? words.map((w) => w[0]).join("") : (words[0] ?? "PRJ").slice(0, 4)
  return key.slice(0, 6) || "PRJ"
}

export const ProjectsLive = Layer.effect(
  Projects,
  Effect.gen(function* () {
    const { use } = yield* Database
    const activity = yield* Activity
    const notices = yield* Notices
    const defaults = yield* HarnessSettings
    // Git runs through effect/process; capture the spawner so the service interface stays free of it.
    const withProcesses = Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, yield* ChildProcessSpawner.ChildProcessSpawner)

    const get = (id: string) =>
      use((db) => db.select().from(projects).where(eq(projects.id, id)).get()).pipe(
        Effect.flatMap((r) => (r ? Effect.succeed(toProject(r)) : Effect.fail(new NotFound({ entity: "project", id }))))
      )

    const validateRepo = (repoPath: string) =>
      withProcesses(Effect.gen(function* () {
        const path = resolve(repoPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))
        if (!existsSync(path)) return yield* new BadRequest({ message: `Path does not exist: ${path}` })
        if (!(yield* Git.isRepository(path))) return yield* new BadRequest({ message: `Not a git repository: ${path}` })
        return yield* Git.repoRoot(path).pipe(Effect.orElseSucceed(() => path))
      })).pipe(Effect.withSpan("Projects.validateRepo", { attributes: { repoPath } }))

    const create = Effect.fn("Projects.create")(function* (body: CreateProjectBody) {
        const configured = yield* defaults.get
        const repoPath = yield* validateRepo(body.repoPath)
        const key = (body.key?.trim() || deriveKey(body.name)).toUpperCase().replace(/[^A-Z0-9]/g, "")
        if (!key) return yield* new BadRequest({ message: "Project key must contain letters or digits" })
        const existing = yield* use((db) => db.select().from(projects).where(eq(projects.key, key)).get())
        if (existing) return yield* new Conflict({ message: `Project key ${key} is already used` })
        const defaultBranch = body.defaultBranch || (yield* withProcesses(Git.defaultBranch(repoPath)))
        const gitProvider = body.gitProvider ?? Git.detectProvider(yield* withProcesses(Git.remoteUrl(repoPath)))
        const now = yield* nowIso
        const row: ProjectRow = {
          id: newId(),
          key,
          name: body.name,
          repoPath,
          defaultBranch,
          gitProvider,
          defaultHarness: body.defaultHarness ?? configured.defaultHarness,
          defaultWorkflowId: body.defaultWorkflowId ?? null,
          permissionMode: body.permissionMode ?? "ask",
          inheritHarnessPermissions: body.inheritHarnessPermissions ?? body.permissionMode === undefined,
          testCommand: body.testCommand ?? null,
          ticketCounter: 0,
          createdAt: now,
          updatedAt: now
        }
        yield* use((db) => db.insert(projects).values(row).run())
        yield* activity.record({ kind: "project.created", message: `Project ${body.name} registered`, actor: "user" })
        yield* notices.publish({ topic: "projects" })
        yield* Effect.annotateCurrentSpan({ projectId: row.id, key })
        return toProject(row)
      })

    const update = Effect.fn("Projects.update")(function* (id: string, body: UpdateProjectBody) {
        yield* get(id)
        const updatedAt = yield* nowIso
        const repoPath = body.repoPath ? yield* validateRepo(body.repoPath) : undefined
        yield* use((db) =>
          db
            .update(projects)
            .set({
              ...(body.name !== undefined && { name: body.name }),
              ...(repoPath !== undefined && { repoPath }),
              ...(body.defaultBranch !== undefined && { defaultBranch: body.defaultBranch }),
              ...(body.gitProvider !== undefined && { gitProvider: body.gitProvider }),
              ...(body.defaultHarness !== undefined && { defaultHarness: body.defaultHarness }),
              ...(body.defaultWorkflowId !== undefined && { defaultWorkflowId: body.defaultWorkflowId }),
              ...(body.permissionMode !== undefined && { permissionMode: body.permissionMode, inheritHarnessPermissions: false }),
              ...(body.inheritHarnessPermissions !== undefined && { inheritHarnessPermissions: body.inheritHarnessPermissions }),
              ...(body.testCommand !== undefined && { testCommand: body.testCommand }),
              updatedAt
            })
            .where(eq(projects.id, id))
            .run()
        )
        yield* notices.publish({ topic: "projects" })
        return yield* get(id)
      })

    const remove = Effect.fn("Projects.remove")(function* (id: string) {
        yield* get(id)
        const n = yield* use((db) => db.select({ n: count() }).from(tickets).where(eq(tickets.projectId, id)).get()?.n ?? 0)
        if (n > 0) return yield* new Conflict({ message: "Project still has tickets; move or delete them first" })
        yield* use((db) => db.delete(projects).where(eq(projects.id, id)).run())
        yield* notices.publish({ topic: "projects" })
      })

    return Projects.of({
      list: use((db) => db.select().from(projects).orderBy(asc(projects.name)).all().map(toProject)),
      get,
      create,
      update,
      remove
    })
  })
)
