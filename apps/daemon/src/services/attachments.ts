import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { extname, isAbsolute, join, resolve } from "node:path"
import type { ImageRef } from "@agentdesk/contracts"
import type { PromptImage } from "@agentdesk/harness-core"
import { Context, Effect, Layer } from "effect"
import { DaemonConfig } from "../config"
import { BadRequest, NotFound } from "../errors"

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp"
}
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
}

export const imageMimeForPath = (path: string) => MIME_BY_EXT[extname(path).toLowerCase()]

export interface AttachmentsShape {
  /** Store image bytes (content-addressed, so re-sending the same screenshot is free). */
  readonly save: (bytes: Uint8Array, mimeType: string, name?: string) => Effect.Effect<ImageRef, BadRequest>
  readonly read: (id: string) => Effect.Effect<{ bytes: Uint8Array; mimeType: string; path: string }, NotFound>
  /** Load attachments for a prompt, in the shape harness adapters take. */
  readonly forPrompt: (ids: ReadonlyArray<string>) => Effect.Effect<Array<PromptImage>, NotFound>
  /** Turn an adapter's inline/path image source into a stored reference. */
  readonly fromSource: (
    source: { data?: string; path?: string; mimeType?: string; name?: string },
    cwd: string
  ) => Effect.Effect<ImageRef, BadRequest>
}

export class Attachments extends Context.Service<Attachments, AttachmentsShape>()("agentdesk/Attachments") {}

const ID = /^[0-9a-f]{64}$/

export const AttachmentsLive = Layer.effect(
  Attachments,
  Effect.gen(function* () {
    const config = yield* DaemonConfig
    const dir = join(config.dataDir, "attachments")

    const fileFor = (id: string) => {
      for (const ext of Object.values(EXT_BY_MIME)) {
        const p = join(dir, id + ext)
        if (existsSync(p)) return p
      }
      return undefined
    }

    const save: AttachmentsShape["save"] = (bytes, mimeType, name) =>
      Effect.gen(function* () {
        const ext = EXT_BY_MIME[mimeType]
        if (!ext) return yield* new BadRequest({ message: `Unsupported image type ${mimeType} (PNG, JPEG, GIF or WebP)` })
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
          return yield* new BadRequest({ message: `Images must be between 1 byte and ${MAX_IMAGE_BYTES / 1024 / 1024} MB` })
        }
        const id = createHash("sha256").update(bytes).digest("hex")
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dir, { recursive: true })
            const path = join(dir, id + ext)
            if (!existsSync(path)) await writeFile(path, bytes, { mode: 0o600 })
          },
          catch: (e) => new BadRequest({ message: `Could not store image: ${String(e)}` })
        })
        return { id, mimeType, size: bytes.byteLength, ...(name && { name }) }
      })

    const read: AttachmentsShape["read"] = (id) =>
      Effect.gen(function* () {
        const path = ID.test(id) ? fileFor(id) : undefined
        if (!path) return yield* new NotFound({ entity: "Attachment", id })
        const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: () => new NotFound({ entity: "Attachment", id }) })
        return { bytes, mimeType: imageMimeForPath(path)!, path }
      })

    const forPrompt: AttachmentsShape["forPrompt"] = (ids) =>
      Effect.forEach(ids, (id) =>
        read(id).pipe(Effect.map((a) => ({ mimeType: a.mimeType, data: Buffer.from(a.bytes).toString("base64"), path: a.path })))
      )

    const fromSource: AttachmentsShape["fromSource"] = (source, cwd) =>
      Effect.gen(function* () {
        if (source.data) {
          return yield* save(Buffer.from(source.data, "base64"), source.mimeType ?? "image/png", source.name)
        }
        if (source.path) {
          const path = isAbsolute(source.path) ? source.path : resolve(cwd, source.path)
          const mimeType = source.mimeType ?? imageMimeForPath(path)
          if (!mimeType) return yield* new BadRequest({ message: `Not an image: ${source.path}` })
          const bytes = yield* Effect.tryPromise({
            try: async () => {
              const info = await stat(path)
              if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("not a readable image")
              return readFile(path)
            },
            catch: () => new BadRequest({ message: `Image not readable: ${source.path}` })
          })
          return yield* save(bytes, mimeType, source.name ?? path.split("/").at(-1))
        }
        return yield* new BadRequest({ message: "Image event without data" })
      })

    return Attachments.of({ save, read, forPrompt, fromSource })
  })
)
