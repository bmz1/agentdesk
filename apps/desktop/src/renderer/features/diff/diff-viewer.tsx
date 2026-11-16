import type { Diff } from "@agentdesk/contracts"
import { ChevronRight, FileCode2, GitCommit } from "lucide-react"
import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/misc"
import { cn } from "@/lib/utils"

interface FilePatch {
  path: string
  lines: Array<{ kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; oldNo?: number; newNo?: number }>
}

export const parsePatch = (patch: string): Array<FilePatch> => {
  const files: Array<FilePatch> = []
  let current: FilePatch | undefined
  let oldNo = 0
  let newNo = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line)
      current = { path: m?.[1] ?? line, lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
      oldNo = Number(m?.[1] ?? 0)
      newNo = Number(m?.[2] ?? 0)
      current.lines.push({ kind: "hunk", text: line })
    } else if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ")) {
      continue
    } else if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ })
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ })
    } else if (line.startsWith("\\")) {
      current.lines.push({ kind: "meta", text: line })
    } else if (line.startsWith(" ") && current.lines.length > 0) {
      current.lines.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return files
}

export const DiffViewer = ({ diff }: { diff: Diff }) => {
  const files = useMemo(() => parsePatch(diff.patch), [diff.patch])
  const stats = new Map(diff.files.map((f) => [f.path, f]))
  if (files.length === 0 && diff.commits.length === 0) {
    return (
      <EmptyState icon={<FileCode2 />} title="No changes yet">
        Changes made by agents in this ticket's worktree will appear here.
      </EmptyState>
    )
  }
  const additions = diff.files.reduce((a, f) => a + f.additions, 0)
  const deletions = diff.files.reduce((a, f) => a + f.deletions, 0)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        {diff.branch && <Badge tone="outline" className="font-mono">{diff.branch}</Badge>}
        <span>
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="text-success">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
        {diff.baseCommit && <span className="font-mono text-fg-subtle">base {diff.baseCommit.slice(0, 8)}</span>}
      </div>
      {diff.commits.length > 0 && (
        <div className="rounded-md border bg-bg-subtle p-2">
          {diff.commits.map((c) => (
            <div key={c.sha} className="flex items-center gap-2 text-xs">
              <GitCommit className="size-3.5 text-fg-subtle" />
              <span className="font-mono text-fg-subtle">{c.sha.slice(0, 8)}</span>
              <span>{c.subject}</span>
            </div>
          ))}
        </div>
      )}
      {files.map((f) => (
        <FileBlock key={f.path} file={f} stat={stats.get(f.path)} />
      ))}
    </div>
  )
}

const FileBlock = ({ file, stat }: { file: FilePatch; stat?: Diff["files"][number] }) => {
  const [open, setOpen] = useState(true)
  return (
    <div className="overflow-hidden rounded-md border" data-testid="diff-file">
      <button className="flex w-full items-center gap-2 bg-bg-subtle px-3 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        <span className="font-mono text-xs">{file.path}</span>
        {stat && <Badge tone="neutral">{stat.status}</Badge>}
        <span className="ml-auto text-[11px]">
          {stat && (
            <>
              <span className="text-success">+{stat.additions}</span> <span className="text-danger">−{stat.deletions}</span>
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto bg-bg font-mono text-[12px] leading-5">
          {file.lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "flex whitespace-pre",
                l.kind === "add" && "bg-success/10",
                l.kind === "del" && "bg-danger/10",
                l.kind === "hunk" && "bg-info/5 text-info",
                l.kind === "meta" && "text-fg-subtle"
              )}
            >
              <span className="w-10 shrink-0 select-none pr-2 text-right text-fg-subtle">{l.oldNo ?? ""}</span>
              <span className="w-10 shrink-0 select-none pr-2 text-right text-fg-subtle">{l.newNo ?? ""}</span>
              <span className={cn("w-4 shrink-0 select-none", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-danger" : "")}>
                {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
              </span>
              <span className="pr-4">{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
