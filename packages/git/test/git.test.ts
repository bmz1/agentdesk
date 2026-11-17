import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeProcessLayer } from "@agentdesk/harness-core"
import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as Git from "../src"

const makeRepo = () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-"))
  execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: dir })
  writeFileSync(join(dir, "README.md"), "hello\n")
  execSync("git add . && git commit -qm init", { cwd: dir })
  return dir
}

layer(NodeProcessLayer, { excludeTestServices: true })("git", (it) => {
  it.effect("creates a worktree, diffs changes including untracked files, commits and removes", () =>
    Effect.gen(function* () {
      const repo = makeRepo()
      const wt = join(mkdtempSync(join(tmpdir(), "wt-")), "w")
      const base = yield* Git.revParse(repo, "main")
      yield* Git.worktreeAdd(repo, wt, "agentdesk/t-1", base)
      writeFileSync(join(wt, "README.md"), "hello\nworld\n")
      writeFileSync(join(wt, "new.txt"), "new\n")
      const diff = yield* Git.diffAgainst(wt, base)
      expect(diff.files.map((f) => f.path).sort()).toEqual(["README.md", "new.txt"])
      expect(diff.files.find((f) => f.path === "new.txt")?.status).toBe("added")
      expect(diff.patch).toContain("+world")
      expect(yield* Git.commitAll(wt, "agent changes")).toMatch(/^[0-9a-f]{40}$/)
      const after = yield* Git.diffAgainst(wt, base)
      expect(after.commits).toHaveLength(1)
      expect(after.branch).toBe("agentdesk/t-1")
      expect(yield* Git.isClean(wt)).toBe(true)
      yield* Git.worktreeRemove(repo, wt)
      expect(existsSync(wt)).toBe(false)
    })
  )

  it.effect("fails with a typed GitError", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Git.revParse(makeRepo(), "does-not-exist"))
      expect(error._tag).toBe("GitError")
    })
  )

  it("detects providers and slugifies", () => {
    expect(Git.detectProvider("git@github.com:a/b.git")).toBe("github")
    expect(Git.detectProvider("https://gitlab.example.com/a/b")).toBe("gitlab")
    expect(Git.slugify("Fix: Payment Gateway (v2)!")).toBe("fix-payment-gateway-v2")
  })
})
