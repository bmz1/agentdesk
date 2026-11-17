import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeRepo, startTestDaemon, waitFor } from "./helpers"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

// A 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("images in agent sessions", () => {
  it("uploads, sends to the harness, and stores agent images by reference", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const raw = (path: string) => fetch(daemon.url + path, { headers: { authorization: "Bearer test-token" } })

    await expect(api.post("/attachments", { mimeType: "image/svg+xml", data: "PHN2Zy8+" })).rejects.toMatchObject({ status: 400 })
    const ref = await api.post("/attachments", { mimeType: "image/png", data: PNG, name: "shot.png" })
    expect(ref).toMatchObject({ mimeType: "image/png", name: "shot.png", size: 70 })
    const res = await raw(`/attachments/${ref.id}`)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(PNG)
    expect((await raw("/attachments/../../etc")).status).toBe(404)

    const p = await api.post("/projects", { name: "Img", key: "IMG", repoPath: makeRepo(), defaultHarness: "mock", permissionMode: "accept_edits" })
    const t = await api.post("/tickets", { projectId: p.id, title: "Look at this" })
    const s = await api.post(`/tickets/${t.id}/sessions`, { prompt: "What is in the screenshot? [noop]", images: [ref.id] })
    const history = await waitFor(async () => {
      const h = await api.get(`/sessions/${s.id}/history`)
      return h.some((e: any) => e.event.type === "turn.completed") ? h : undefined
    })
    const prompt = history.find((e: any) => e.event.type === "user.prompt").event
    expect(prompt.images).toEqual([expect.objectContaining({ id: ref.id, mimeType: "image/png" })])
    // The mock echoes the image back as a screenshot: persisted as a reference, never as base64.
    const image = history.find((e: any) => e.event.type === "image").event
    expect(image).toEqual({ type: "image", toolCallId: "screenshot-1", image: expect.objectContaining({ id: ref.id }) })
    expect(JSON.stringify(history)).not.toContain(PNG)

    // Follow-ups carry images too.
    await api.post(`/sessions/${s.id}/prompt`, { text: "And this one? [noop]", images: [ref.id] })
    await waitFor(async () => {
      const h = await api.get(`/sessions/${s.id}/history`)
      return h.filter((e: any) => e.event.type === "image").length === 2 || undefined
    })
  })

  it("previews image files from the ticket tree", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    writeFileSync(join(repo, "shot.png"), Buffer.from(PNG, "base64"))
    const p = await api.post("/projects", { name: "Prev", key: "PRV", repoPath: repo })
    const t = await api.post("/tickets", { projectId: p.id, title: "Preview" })
    const res = await fetch(`${daemon.url}/tickets/${t.id}/raw?path=shot.png`, { headers: { authorization: "Bearer test-token" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    await expect(api.get(`/tickets/${t.id}/raw?path=README.md`)).rejects.toMatchObject({ status: 400 })
  })
})
