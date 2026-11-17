import type { GitProvider } from "@agentdesk/contracts"
import { findExecutable, runCommand } from "@agentdesk/harness-core"
import { Effect, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"

export class PullRequestError extends Schema.TaggedError<PullRequestError>()("PullRequestError", {
  message: Schema.String
}) {}

export interface PullRequestInput {
  readonly cwd: string
  readonly branch: string
  readonly base: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
}

export interface PullRequestRef {
  readonly url: string
  readonly number?: number
  readonly existing: boolean
}

/**
 * Creates draft PRs/MRs through the provider's official CLI, using the user's
 * own CLI login. Creation is idempotent: an open PR for the branch is reused,
 * so retries after a crash never create duplicates. Never merges.
 */
export interface PullRequestProvider {
  readonly id: GitProvider
  readonly findOpen: (
    cwd: string,
    branch: string
  ) => Effect.Effect<PullRequestRef | undefined, PullRequestError, ChildProcessSpawner.ChildProcessSpawner>
  readonly create: (input: PullRequestInput) => Effect.Effect<PullRequestRef, PullRequestError, ChildProcessSpawner.ChildProcessSpawner>
}

/** Tokens are stripped from agent processes; provider CLIs get them back explicitly. */
const providerEnv = (keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))

const cli = (name: string, args: ReadonlyArray<string>, cwd: string, envKeys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bin = findExecutable(name)
    if (!bin) return yield* new PullRequestError({ message: `${name} CLI not found; install and log in to create pull requests` })
    const r = yield* runCommand(bin, args, { cwd, timeoutMs: 120_000, env: { ...providerEnv(envKeys), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } })
    if (r.code !== 0) return yield* new PullRequestError({ message: `${name} ${args[0]} ${args[1]} failed: ${(r.stderr || r.stdout).trim()}` })
    return r.stdout
  })

export const githubProvider = (bin = "gh"): PullRequestProvider => {
  const env = ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]
  const findOpen = (cwd: string, branch: string) =>
    cli(bin, ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number", "--limit", "1"], cwd, env).pipe(
      Effect.map((out) => {
        const list = JSON.parse(out || "[]") as Array<{ url: string; number: number }>
        return list[0] ? { url: list[0].url, number: list[0].number, existing: true } : undefined
      })
    )
  return {
    id: "github",
    findOpen,
    create: (i) =>
      Effect.gen(function* () {
        const existing = yield* findOpen(i.cwd, i.branch)
        if (existing) return existing
        const out = yield* cli(
          bin,
          ["pr", "create", "--head", i.branch, "--base", i.base, "--title", i.title, "--body", i.body, ...(i.draft ? ["--draft"] : [])],
          i.cwd,
          env
        )
        const url = out.trim().split("\n").at(-1) ?? ""
        return { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]) || undefined, existing: false }
      })
  }
}

export const gitlabProvider = (bin = "glab"): PullRequestProvider => {
  const env = ["GITLAB_TOKEN", "GL_TOKEN", "GITLAB_HOST"]
  const findOpen = (cwd: string, branch: string) =>
    cli(bin, ["mr", "list", "--source-branch", branch, "--output", "json"], cwd, env).pipe(
      Effect.map((out) => {
        const list = JSON.parse(out || "[]") as Array<{ web_url: string; iid: number }>
        return list[0] ? { url: list[0].web_url, number: list[0].iid, existing: true } : undefined
      })
    )
  return {
    id: "gitlab",
    findOpen,
    create: (i) =>
      Effect.gen(function* () {
        const existing = yield* findOpen(i.cwd, i.branch)
        if (existing) return existing
        const out = yield* cli(
          bin,
          [
            "mr",
            "create",
            "--source-branch",
            i.branch,
            "--target-branch",
            i.base,
            "--title",
            i.title,
            "--description",
            i.body,
            "--yes",
            ...(i.draft ? ["--draft"] : [])
          ],
          i.cwd,
          env
        )
        const url = /(https?:\/\/\S+\/merge_requests\/\d+)/.exec(out)?.[1] ?? out.trim().split("\n").at(-1) ?? ""
        return { url, number: Number(/merge_requests\/(\d+)/.exec(url)?.[1]) || undefined, existing: false }
      })
  }
}

export const providerFor = (id: GitProvider): PullRequestProvider | undefined =>
  id === "github" ? githubProvider() : id === "gitlab" ? gitlabProvider() : undefined
