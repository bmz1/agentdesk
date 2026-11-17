import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
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

  it("saves edits with an optimistic version check", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    writeFileSync(join(repo, "notes.md"), "one\n", { mode: 0o640 })
    writeFileSync(join(repo, "creds.ts"), 'const k = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n')
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3]))
    const p = await api.post("/projects", { name: "Edit", key: "EDT", repoPath: repo })
    const t = await api.post("/tickets", { projectId: p.id, title: "Edit" })
    const file = `/tickets/${t.id}/file`

    const opened = await api.get(`${file}?path=notes.md`)
    expect(opened).toMatchObject({ editable: true, version: expect.stringMatching(/^[0-9a-f]{64}$/) })

    const saved = await api.put(file, { path: "notes.md", content: "two\n", baseVersion: opened.version })
    expect(saved).toMatchObject({ content: "two\n", editable: true })
    expect(saved.version).not.toBe(opened.version)
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("two\n")
    expect(statSync(join(repo, "notes.md")).mode & 0o777).toBe(0o640)

    // Someone else (an agent) changes the file; a save from the stale read is refused…
    writeFileSync(join(repo, "notes.md"), "agent\n")
    await expect(api.put(file, { path: "notes.md", content: "mine\n", baseVersion: saved.version })).rejects.toMatchObject({
      status: 409,
      body: { error: "StaleFile" }
    })
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("agent\n")
    // …unless the user chooses to overwrite.
    await api.put(file, { path: "notes.md", content: "mine\n", baseVersion: saved.version, force: true })
    expect(readFileSync(join(repo, "notes.md"), "utf8")).toBe("mine\n")

    // Redacted and binary files cannot round-trip, so they are read-only.
    const creds = await api.get(`${file}?path=creds.ts`)
    expect(creds).toMatchObject({ editable: false, readonlyReason: expect.any(String) })
    await expect(api.put(file, { path: "creds.ts", content: "x", baseVersion: creds.version, force: true })).rejects.toMatchObject({ status: 400 })
    expect((await api.get(`${file}?path=blob.bin`)).editable).toBe(false)

    for (const bad of ["../../etc/passwd", ".git/config", "missing.txt"]) {
      await expect(api.put(file, { path: bad, content: "x", baseVersion: "", force: true })).rejects.toMatchObject({ status: expect.any(Number) })
    }
  })
})
