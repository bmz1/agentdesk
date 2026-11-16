import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Git from "../src"

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-"))
  execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "hello\n")
  execSync("git add . && git commit -qm init", { cwd: dir })
  return dir
}

describe("git", () => {
  it("creates a worktree, diffs changes including untracked files, commits and removes", async () => {
    const repo = makeRepo()
    const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "w")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const base = yield* Git.revParse(repo, "main")
        yield* Git.worktreeAdd(repo, wt, "agentdesk/t-1", base)
        writeFileSync(join(wt, "README.md"), "hello\nworld\n")
        writeFileSync(join(wt, "new.txt"), "new\n")
        const diff = yield* Git.diffAgainst(wt, base)
        const sha = yield* Git.commitAll(wt, "agent changes")
        const after = yield* Git.diffAgainst(wt, base)
        const clean = yield* Git.isClean(wt)
        yield* Git.worktreeRemove(repo, wt)
        return { diff, sha, after, clean, branch: after.branch }
      })
    )
    expect(result.diff.files.map((f) => f.path).sort()).toEqual(["README.md", "new.txt"])
    expect(result.diff.files.find((f) => f.path === "new.txt")?.status).toBe("added")
    expect(result.diff.patch).toContain("+world")
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(result.after.commits).toHaveLength(1)
    expect(result.clean).toBe(true)
    expect(result.branch).toBe("agentdesk/t-1")
    expect(existsSync(wt)).toBe(false)
  })

  it("detects providers and slugifies", () => {
    expect(Git.detectProvider("git@github.com:a/b.git")).toBe("github")
    expect(Git.detectProvider("https://gitlab.example.com/a/b")).toBe("gitlab")
    expect(Git.slugify("Fix: Payment Gateway (v2)!")).toBe("fix-payment-gateway-v2")
  })
})
