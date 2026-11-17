import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe("ticket file browser", () => {
  it("lists git-visible files with change markers and reads them safely", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    writeFileSync(join(repo, ".gitignore"), ".env\n")
    writeFileSync(join(repo, ".env"), "SECRET=1\n")
    mkdirSync(join(repo, "src"))
    writeFileSync(join(repo, "src", "app.ts"), "export const x = 1\n")
    writeFileSync(join(repo, "README.md"), "# changed\n")
    symlinkSync("/etc/hosts", join(repo, "escape"))
    const p = await api.post("/projects", { name: "Files", key: "FIL", repoPath: repo })
    const t = await api.post("/tickets", { projectId: p.id, title: "Browse" })

    const tree = await api.get(`/tickets/${t.id}/files`)
    expect(tree).toMatchObject({ origin: "repository", truncated: false })
    const paths = tree.files.map((f: { path: string }) => f.path)
    expect(paths).toEqual(expect.arrayContaining([".gitignore", "README.md", "src/app.ts"]))
    expect(paths).not.toContain(".env")
    expect(tree.files.find((f: { path: string }) => f.path === "README.md").status).toBe("M")
    expect(tree.files.find((f: { path: string }) => f.path === "src/app.ts").status).toBe("??")

    expect(await api.get(`/tickets/${t.id}/file?path=src/app.ts`)).toMatchObject({ content: "export const x = 1\n", binary: false })
    for (const bad of ["../../etc/passwd", "/etc/passwd", ".env", ".git/config", "escape"]) {
      await expect(api.get(`/tickets/${t.id}/file?path=${encodeURIComponent(bad)}`)).rejects.toMatchObject({
        status: expect.any(Number)
      })
    }
  })
})
