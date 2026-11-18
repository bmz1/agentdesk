import type { FileTree } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronRight, Copy, File, FileDiff, Folder, FolderOpen, FolderSearch, Lock, RefreshCw, Search } from "lucide-react"
import type * as React from "react"
import { useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { EmptyState, Spinner, Tooltip } from "@/components/ui/misc"
import { bridge } from "@/lib/connection"
import { api } from "@/lib/api"
import { q } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { ImageFrame, useObjectUrl } from "../session/images"
import { CodeSurface } from "./code-surface"
import { FileEditor } from "./file-editor"

type FileEntry = FileTree["files"][number]

interface DirNode {
  readonly name: string
  readonly path: string
  readonly dirs: Map<string, DirNode>
  readonly files: Array<FileEntry & { name: string }>
  changed: number
}

const buildTree = (files: ReadonlyArray<FileEntry>): DirNode => {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], changed: 0 }
  for (const f of files) {
    const parts = f.path.split("/")
    let node = root
    if (f.status) root.changed++
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]!
      let next = node.dirs.get(name)
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [], changed: 0 }
        node.dirs.set(name, next)
      }
      if (f.status) next.changed++
      node = next
    }
    node.files.push({ ...f, name: parts.at(-1)! })
  }
  return root
}

type Row =
  | { kind: "dir"; node: DirNode; depth: number; open: boolean }
  | { kind: "file"; file: FileEntry & { name: string }; depth: number }

const flatten = (node: DirNode, expanded: ReadonlySet<string>, depth = 0, out: Array<Row> = []) => {
  for (const dir of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const open = expanded.has(dir.path)
    out.push({ kind: "dir", node: dir, depth, open })
    if (open) flatten(dir, expanded, depth + 1, out)
  }
  for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) out.push({ kind: "file", file, depth })
  return out
}

const STATUS_STYLE: Record<string, string> = {
  M: "text-warning",
  A: "text-success",
  "??": "text-success",
  D: "text-danger",
  R: "text-info"
}
const statusClass = (s: string | undefined) => (s ? (STATUS_STYLE[s] ?? STATUS_STYLE[s[0]!] ?? "text-warning") : "")
const statusLabel = (s: string) => (s === "??" ? "U" : s[0]!)

const ROW_H = 24

/** Browser (and editor) over the ticket's worktree (or the project repo before an agent has started). */
export const FileBrowser = ({ ticketId, onShowChanges }: { ticketId: string; onShowChanges: () => void }) => {
  const tree = useQuery(q.ticketFiles(ticketId))
  const [selected, setSelected] = useState<string>()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState("")
  const [changedOnly, setChangedOnly] = useState(false)
  // Unsaved edits in the open file; switching files asks before throwing them away.
  const [dirty, setDirty] = useState(false)
  const [pendingSelect, setPendingSelect] = useState<string>()
  const select = (path: string) => {
    if (path === selected) return
    if (dirty) setPendingSelect(path)
    else setSelected(path)
  }

  const files = tree.data?.files ?? []
  const root = useMemo(() => buildTree(files), [files])
  const term = filter.trim().toLowerCase()
  // Filtering switches to a flat list of matching paths: faster to scan than a half-expanded tree.
  const rows: Array<Row> = useMemo(() => {
    if (term || changedOnly) {
      return files
        .filter((f) => (!changedOnly || f.status) && (!term || f.path.toLowerCase().includes(term)))
        .map((f) => ({ kind: "file" as const, file: { ...f, name: f.path }, depth: 0 }))
    }
    return flatten(root, expanded)
  }, [files, root, expanded, term, changedOnly])

  const listRef = useRef<HTMLDivElement>(null)
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => listRef.current, estimateSize: () => ROW_H, overscan: 12 })

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  if (tree.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }
  if (tree.error) return <EmptyState title="Could not list files">{(tree.error as Error).message}</EmptyState>

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="space-y-2 border-b p-2">
          <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span className="rounded bg-bg-muted px-1.5 py-0.5 font-medium">{tree.data?.origin === "worktree" ? "Worktree" : "Repository"}</span>
            <span className="truncate font-mono" title={tree.data?.root}>
              {tree.data?.root.split("/").at(-1)}
            </span>
            <div className="flex-1" />
            <Tooltip content="Refresh">
              <button className="rounded p-1 hover:bg-bg-muted hover:text-fg" onClick={() => tree.refetch()}>
                <RefreshCw className={cn("size-3", tree.isFetching && "animate-spin")} />
              </button>
            </Tooltip>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="h-7 w-full pl-7" />
          </div>
          <div className="flex items-center gap-1 text-[11px]">
            {(["All", "Changed"] as const).map((label) => {
              const active = (label === "Changed") === changedOnly
              return (
                <button
                  key={label}
                  onClick={() => setChangedOnly(label === "Changed")}
                  className={cn("rounded px-2 py-0.5", active ? "bg-bg-muted text-fg" : "text-fg-muted hover:text-fg")}
                >
                  {label}
                  {label === "Changed" && root.changed > 0 && <span className="ml-1 text-warning">{root.changed}</span>}
                </button>
              )
            })}
            <span className="ml-auto text-fg-subtle">{files.length.toLocaleString()} files</span>
          </div>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="file-tree">
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fg-subtle">{changedOnly ? "No changed files" : "No matching files"}</p>
          ) : (
            <div style={{ height: virtual.getTotalSize() }} className="relative">
              {virtual.getVirtualItems().map((v) => {
                const row = rows[v.index]!
                const pad = { paddingLeft: 8 + row.depth * 12 }
                const style = { ...pad, height: ROW_H, transform: `translateY(${v.start}px)` }
                if (row.kind === "dir") {
                  return (
                    <button
                      key={row.node.path}
                      style={style}
                      onClick={() => toggle(row.node.path)}
                      className="absolute inset-x-0 top-0 flex items-center gap-1 pr-2 text-left text-[13px] text-fg-muted hover:bg-bg-muted hover:text-fg"
                    >
                      <ChevronRight className={cn("size-3 shrink-0 transition-transform", row.open && "rotate-90")} />
                      {row.open ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />}
                      <span className="truncate">{row.node.name}</span>
                      {row.node.changed > 0 && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-warning" />}
                    </button>
                  )
                }
                const f = row.file
                return (
                  <button
                    key={f.path}
                    style={{ ...style, paddingLeft: style.paddingLeft + (term || changedOnly ? 0 : 16) }}
                    onClick={() => select(f.path)}
                    title={f.path}
                    className={cn(
                      "absolute inset-x-0 top-0 flex items-center gap-1.5 pr-2 text-left text-[13px] hover:bg-bg-muted",
                      selected === f.path ? "bg-accent/15 text-fg" : "text-fg-muted"
                    )}
                  >
                    <File className="size-3.5 shrink-0 opacity-70" />
                    <span className={cn("truncate", statusClass(f.status))}>{f.name}</span>
                    {f.status && <span className={cn("ml-auto shrink-0 font-mono text-[10px]", statusClass(f.status))}>{statusLabel(f.status)}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        {tree.data?.truncated && <p className="border-t px-3 py-1.5 text-[11px] text-warning">Showing the first {files.length.toLocaleString()} files.</p>}
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <FileView
            key={selected}
            ticketId={ticketId}
            path={selected}
            root={tree.data!.root}
            status={files.find((f) => f.path === selected)?.status}
            onShowChanges={onShowChanges}
            onDirtyChange={setDirty}
          />
        ) : (
          <EmptyState icon={<FolderSearch />} title="Select a file">
            Browse the {tree.data?.origin === "worktree" ? "ticket's worktree" : "project repository"}. Files the agent changed are highlighted.
          </EmptyState>
        )}
      </section>
      <Dialog open={pendingSelect !== undefined} onOpenChange={(open) => !open && setPendingSelect(undefined)}>
        <DialogContent title="Discard unsaved changes?" description={`Your edits to ${selected} have not been saved.`} className="w-[420px]">
          <div className="flex justify-end gap-2 p-4">
            <Button variant="ghost" onClick={() => setPendingSelect(undefined)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDirty(false)
                setSelected(pendingSelect)
                setPendingSelect(undefined)
              }}
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

const FileView = ({
  ticketId,
  path,
  root,
  status,
  onShowChanges,
  onDirtyChange
}: {
  ticketId: string
  path: string
  root: string
  status: string | undefined
  onShowChanges: () => void
  onDirtyChange: (dirty: boolean) => void
}) => {
  const isImage = IMAGE_EXT.test(path)
  const file = useQuery({ ...q.ticketFile(ticketId, path), enabled: !isImage })
  const image = useQuery({
    queryKey: ["tickets", "detail", ticketId, "files", path, "image"],
    queryFn: () => api.ticketImage(ticketId, path),
    enabled: isImage,
    refetchInterval: 10_000
  })
  const imageUrl = useObjectUrl(image.data)
  const absolute = `${root}/${path}`

  const header = (actions: React.ReactNode) => (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
      <span className="min-w-0 truncate font-mono text-fg-muted">
        {path.split("/").map((part, i, all) => (
          <span key={i}>
            {i > 0 && <span className="px-1 text-fg-subtle">/</span>}
            <span className={i === all.length - 1 ? "text-fg" : undefined}>{part}</span>
          </span>
        ))}
      </span>
      {status && <span className={cn("font-mono text-[10px]", statusClass(status))}>{statusLabel(status)}</span>}
      <div className="flex-1" />
      {file.data && <span className="text-fg-subtle">{formatBytes(file.data.size)}</span>}
      {image.data && <span className="text-fg-subtle">{formatBytes(image.data.size)}</span>}
      {actions}
      {status && (
        <Button size="sm" variant="ghost" onClick={onShowChanges}>
          <FileDiff /> Diff
        </Button>
      )}
      <Tooltip content="Copy path">
        <Button size="icon" variant="ghost" className="size-6" onClick={() => void navigator.clipboard.writeText(absolute)}>
          <Copy />
        </Button>
      </Tooltip>
      {bridge() && (
        <Tooltip content="Reveal in Finder">
          <Button size="icon" variant="ghost" className="size-6" onClick={() => void bridge()!.revealPath(absolute)}>
            <FolderSearch />
          </Button>
        </Tooltip>
      )}
    </header>
  )

  // Editable files are simply editable: click in, type, save.
  if (!isImage && file.data && !file.data.binary && file.data.editable) {
    return <FileEditor ticketId={ticketId} disk={file.data} onDirtyChange={onDirtyChange} header={header} />
  }

  return (
    <>
      {header(
        file.data &&
          !file.data.binary && (
            <Tooltip content={file.data.readonlyReason ?? "This file can't be edited here"}>
              <span className="flex items-center gap-1 text-fg-subtle" data-testid="file-readonly">
                <Lock className="size-3" /> Read-only
              </span>
            </Tooltip>
          )
      )}
      {isImage ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg p-6" data-testid="file-image">
          {image.error ? (
            <EmptyState title="Can't preview this image">{(image.error as Error).message}</EmptyState>
          ) : (
            <ImageFrame url={imageUrl} loading={image.isLoading} name={path.split("/").at(-1)} className="[&_img]:max-h-[70vh]" />
          )}
        </div>
      ) : file.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : file.error ? (
        <EmptyState title="Can't open this file">{(file.error as Error).message}</EmptyState>
      ) : file.data?.binary ? (
        <EmptyState title="Binary file">{formatBytes(file.data.size)} · not shown</EmptyState>
      ) : file.data ? (
        <CodeSurface text={file.data.content.replace(/\n$/, "")} path={path} data-testid="file-content">
          {file.data.truncated && (
            <p className="sticky bottom-0 border-t bg-bg-subtle px-3 py-1.5 font-sans text-[11px] text-warning">
              Large file: showing the first {formatBytes(file.data.content.length)}.
            </p>
          )}
        </CodeSurface>
      ) : null}
    </>
  )
}

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
