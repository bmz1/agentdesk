import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, sep } from "node:path"
import type { FileContent, FileTree, WriteFileBody } from "@agentdesk/contracts"
import { git, status } from "@agentdesk/git"
import { redactSecrets } from "@agentdesk/harness-core"
import { Effect, Semaphore } from "effect"
import { BadRequest, NotFound, StaleFile } from "../errors"
import { imageMimeForPath, MAX_IMAGE_BYTES } from "./attachments"
import { Projects } from "./projects"
import { Tickets } from "./tickets"
import { Workspaces } from "./workspaces"

const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024

/** The directory a ticket's files are browsed in: its latest worktree, else the project repository. */
const ticketRoot = (ticketId: string) =>
  Effect.gen(function* () {
    const ticket = yield* Tickets.use((t) => t.get(ticketId))
    const ws = yield* Workspaces.use((w) => w.latestForTicket(ticketId))
    if (ws && existsSync(ws.path)) return { root: ws.path, origin: "worktree" as const }
    const project = yield* Projects.use((p) => p.get(ticket.projectId))
    return { root: project.repoPath, origin: "repository" as const }
  })

/** Git's view of the tree: honours .gitignore and never lists `.git`. */
export const listTicketFiles = (ticketId: string) =>
  Effect.gen(function* () {
    const { root, origin } = yield* ticketRoot(ticketId)
    const [listing, changes] = yield* Effect.all(
      [git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]), status(root)],
      { concurrency: 2 }
    )
    const changed = new Map(changes.map((c) => [c.path, c.status]))
    // Deleted files are still in the index; skip what is no longer on disk.
    const paths = [...new Set(listing.split("\0").filter(Boolean))].filter((p) => changed.get(p) !== "D").sort()
    return {
      root,
      origin,
      truncated: paths.length > MAX_FILES,
      files: paths.slice(0, MAX_FILES).map((path) => ({ path, ...(changed.has(path) && { status: changed.get(path)! }) }))
    } satisfies FileTree
  })

const badPath = (path: string) => {
  const parts = path.split(/[\\/]/)
  return !path || isAbsolute(path) || parts.includes("..") || parts[0] === ".git"
}

/**
 * Resolve a path inside the ticket's tree, refusing anything outside it (`..`,
 * absolute paths, symlinks) and git-ignored files (.env, build output).
 */
const resolveTicketPath = (ticketId: string, path: string) =>
  Effect.gen(function* () {
    if (badPath(path)) return yield* new BadRequest({ message: "Invalid file path" })
    const { root } = yield* ticketRoot(ticketId)
    const ignored = yield* git(root, ["check-ignore", "-q", "--", path]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
    if (ignored) return yield* new BadRequest({ message: "Ignored files are not shown" })
    return yield* Effect.tryPromise({
      try: async () => {
        const realRoot = await realpath(root)
        const full = await realpath(join(root, path))
        if (!full.startsWith(realRoot + sep)) throw new Error("outside")
        const info = await stat(full)
        if (!info.isFile()) throw new Error("not a file")
        return { full, size: info.size }
      },
      catch: () => new NotFound({ entity: "File", id: path })
    })
  })

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/**
 * Describe what was read. Only a file that round-trips exactly — text, complete, and
 * with nothing redacted — is editable; saving anything else would corrupt it.
 */
const toFileContent = (path: string, size: number, bytes: Buffer): FileContent => {
  const binary = bytes.subarray(0, 8000).includes(0)
  const truncated = size > bytes.length
  const text = binary ? "" : bytes.toString("utf8")
  const content = redactSecrets(text)
  const readonlyReason = binary
    ? "Binary files can't be edited"
    : truncated
      ? "Large files can't be edited"
      : content !== text
        ? "Files containing secrets can't be edited here"
        : !Buffer.from(text, "utf8").equals(bytes)
          ? "Files that aren't valid UTF-8 can't be edited"
          : undefined
  return {
    path,
    size,
    binary,
    truncated,
    content,
    version: hash(bytes),
    editable: readonlyReason === undefined,
    ...(readonlyReason && { readonlyReason })
  }
}

const readHead = (full: string, size: number, path: string) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(full, "r")
      try {
        const buf = Buffer.alloc(Math.min(size, MAX_BYTES))
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
        return buf.subarray(0, bytesRead)
      } finally {
        await handle.close()
      }
    },
    catch: () => new NotFound({ entity: "File", id: path })
  })

/** Read one text file (the first 512 KB), with secrets redacted. */
export const readTicketFile = (ticketId: string, path: string) =>
  Effect.gen(function* () {
    const { full, size } = yield* resolveTicketPath(ticketId, path)
    return toFileContent(path, size, yield* readHead(full, size, path))
  })

/**
 * Saves are serialised so the version check and the write happen together for
 * every writer going through the daemon. Agents writing directly can still race
 * in between; the atomic rename means a reader never sees a half-written file.
 */
const writeLock = Semaphore.makeUnsafe(1)

/**
 * Replace an existing file's contents. Fails with `StaleFile` when the file on disk
 * no longer matches `baseVersion`, unless `force` is set (the user chose to overwrite).
 */
export const writeTicketFile = (ticketId: string, input: WriteFileBody) =>
  Effect.gen(function* () {
    const next = Buffer.from(input.content, "utf8")
    if (next.length > MAX_BYTES) return yield* new BadRequest({ message: "File is too large to save from the editor" })
    const { full, size } = yield* resolveTicketPath(ticketId, input.path)
    const current = toFileContent(input.path, size, yield* readHead(full, size, input.path))
    if (!current.editable) return yield* new BadRequest({ message: current.readonlyReason ?? "File can't be edited" })
    if (current.version !== input.baseVersion && !input.force) {
      return yield* new StaleFile({ path: input.path, version: current.version })
    }
    if (current.version === hash(next)) return current
    yield* Effect.tryPromise({
      try: async () => {
        const { mode } = await stat(full)
        const tmp = join(dirname(full), `.${basename(full)}.agentdesk-${randomBytes(4).toString("hex")}.tmp`)
        try {
          await writeFile(tmp, next, { flag: "wx", mode })
          await chmod(tmp, mode)
          await rename(tmp, full)
        } catch (e) {
          await rm(tmp, { force: true })
          throw e
        }
      },
      catch: (e) => new BadRequest({ message: `Could not save ${input.path}: ${(e as Error).message}` })
    })
    return toFileContent(input.path, next.length, next)
  }).pipe(Semaphore.withPermit(writeLock))

/** Raw bytes of an image file in the ticket's tree (PNG, JPEG, GIF, WebP), for previews. */
export const readTicketImage = (ticketId: string, path: string) =>
  Effect.gen(function* () {
    const mimeType = imageMimeForPath(path)
    if (!mimeType) return yield* new BadRequest({ message: "Not a previewable image" })
    const { full, size } = yield* resolveTicketPath(ticketId, path)
    if (size > MAX_IMAGE_BYTES) return yield* new BadRequest({ message: "Image too large to preview" })
    const bytes = yield* Effect.tryPromise({ try: () => readFile(full), catch: () => new NotFound({ entity: "File", id: path }) })
    return { bytes: new Uint8Array(bytes), mimeType }
  })
