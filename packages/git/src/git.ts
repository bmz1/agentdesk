import { existsSync } from "node:fs"
import type { Diff, GitProvider } from "@agentdesk/contracts"
import { runCommand } from "@agentdesk/harness-core"
import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  command: Schema.String,
  message: Schema.String,
  code: Schema.optional(Schema.NullOr(Schema.Number))
}) {}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }

export const git = (cwd: string, args: ReadonlyArray<string>, opts: { timeoutMs?: number } = {}) =>
  runCommand("git", args, { cwd, env: GIT_ENV, timeoutMs: opts.timeoutMs ?? 60_000 }).pipe(
    Effect.flatMap((r) =>
      r.code === 0
        ? Effect.succeed(r.stdout)
        : Effect.fail(new GitError({ command: `git ${args.join(" ")}`, message: (r.stderr || r.stdout).trim(), code: r.code }))
    )
  )

const trimmed = (cwd: string, args: ReadonlyArray<string>) => git(cwd, args).pipe(Effect.map((s) => s.trim()))

export const isRepository = (path: string) =>
  existsSync(path)
    ? trimmed(path, ["rev-parse", "--is-inside-work-tree"]).pipe(
        Effect.map((s) => s === "true"),
        Effect.orElseSucceed(() => false)
      )
    : Effect.succeed(false)

export const repoRoot = (path: string) => trimmed(path, ["rev-parse", "--show-toplevel"])
export const revParse = (cwd: string, ref: string) => trimmed(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])
export const currentBranch = (cwd: string) => trimmed(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])

export const defaultBranch = (cwd: string) =>
  trimmed(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).pipe(
    Effect.map((s) => s.replace(/^origin\//, "")),
    Effect.catch(() => currentBranch(cwd)),
    Effect.orElseSucceed(() => "main")
  )

export const remoteUrl = (cwd: string, remote = "origin") =>
  trimmed(cwd, ["remote", "get-url", remote]).pipe(Effect.orElseSucceed(() => ""))

export const detectProvider = (url: string): GitProvider => {
  if (/github/i.test(url)) return "github"
  if (/gitlab/i.test(url)) return "gitlab"
  return "none"
}

export const branchExists = (cwd: string, branch: string) =>
  git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )

export const worktreeAdd = (repo: string, path: string, branch: string, base: string) =>
  Effect.gen(function* () {
    const exists = yield* branchExists(repo, branch)
    yield* git(repo, exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base])
  })

export const worktreeRemove = (repo: string, path: string, force = false) =>
  git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), path]).pipe(
    Effect.andThen(git(repo, ["worktree", "prune"])),
    Effect.asVoid
  )

export interface WorktreeEntry {
  readonly path: string
  /** Short branch name; null when detached. */
  readonly branch: string | null
  readonly head: string | null
}

/** Parse `git worktree list --porcelain`. The first entry is the main checkout. */
export const parseWorktreeList = (porcelain: string): ReadonlyArray<WorktreeEntry> =>
  porcelain
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n")
      const value = (key: string) => lines.find((l) => l.startsWith(`${key} `))?.slice(key.length + 1) ?? null
      const path = value("worktree")
      return path ? { path, branch: value("branch")?.replace(/^refs\/heads\//, "") ?? null, head: value("HEAD") } : undefined
    })
    .filter((w): w is WorktreeEntry => w !== undefined)

/** Linked worktrees of a repository, excluding the main checkout. */
export const worktreeList = (repo: string) =>
  git(repo, ["worktree", "list", "--porcelain"]).pipe(Effect.map((s) => parseWorktreeList(s).slice(1)))

export interface StatusEntry {
  readonly path: string
  readonly status: string
}

export const status = (cwd: string) =>
  git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]).pipe(
    Effect.map((out) =>
      out
        .split("\n")
        .filter(Boolean)
        .map((l): StatusEntry => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }))
    )
  )

export const isClean = (cwd: string) => status(cwd).pipe(Effect.map((s) => s.length === 0))

export const commitAll = (cwd: string, message: string) =>
  Effect.gen(function* () {
    if (yield* isClean(cwd)) return undefined
    yield* git(cwd, ["add", "-A"])
    yield* git(cwd, ["-c", "user.name=AgentDesk", "-c", "user.email=agentdesk@localhost", "commit", "--no-verify", "-m", message])
    return yield* revParse(cwd, "HEAD")
  })

export const push = (cwd: string, branch: string, remote = "origin") =>
  git(cwd, ["push", "-u", remote, branch], { timeoutMs: 120_000 }).pipe(Effect.asVoid)

const STATUS_NAMES: Record<string, string> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type" }

/**
 * Diff of a worktree against its base commit, including uncommitted and
 * untracked changes (via `git add -N` style intent: we diff the working tree).
 */
export const diffAgainst = (cwd: string, baseCommit: string): Effect.Effect<Diff, GitError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    // Mark untracked files as intent-to-add so they show up in the diff without staging content.
    const untracked = (yield* git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean)
    if (untracked.length > 0) yield* git(cwd, ["add", "-N", "--", ...untracked])
    const numstat = yield* git(cwd, ["diff", "--numstat", baseCommit])
    const names = yield* git(cwd, ["diff", "--name-status", baseCommit])
    const patch = yield* git(cwd, ["diff", "--no-color", baseCommit])
    const log = yield* git(cwd, ["log", "--format=%H%x09%s", `${baseCommit}..HEAD`]).pipe(Effect.orElseSucceed(() => ""))
    const head = yield* revParse(cwd, "HEAD").pipe(Effect.orElseSucceed(() => null))
    const branch = yield* currentBranch(cwd).pipe(Effect.orElseSucceed(() => null))
    const statusByPath = new Map<string, string>()
    for (const l of names.split("\n").filter(Boolean)) {
      const [code, ...paths] = l.split("\t")
      statusByPath.set(paths.at(-1) ?? "", STATUS_NAMES[(code ?? "M")[0]!] ?? "modified")
    }
    const files = numstat
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [add, del, ...rest] = l.split("\t")
        const path = rest
          .join("\t")
          .replace(/^.*=> /, "")
          .replace(/[{}]/g, "")
        return {
          path,
          status: statusByPath.get(path) ?? "modified",
          additions: add === "-" ? 0 : Number(add),
          deletions: del === "-" ? 0 : Number(del)
        }
      })
    return {
      branch,
      baseCommit,
      headCommit: head,
      files,
      patch: patch.length > 2_000_000 ? patch.slice(0, 2_000_000) + "\n… diff truncated …\n" : patch,
      commits: log
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [sha, ...subject] = l.split("\t")
          return { sha: sha ?? "", subject: subject.join("\t") }
        })
    }
  })

/** Turn arbitrary text into a safe branch-name segment. */
export const slugify = (s: string, max = 40) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") || "work"
