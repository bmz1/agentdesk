import type { FileContent } from "@agentdesk/contracts"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type * as React from "react"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/misc"
import { ApiError, api } from "@/lib/api"
import { formatChord, matchesChord } from "@/lib/keymap"
import { qk } from "@/lib/queries"
import { CodeSurface } from "./code-surface"

const INDENT = "  "

/**
 * Replace the textarea's selection through the browser's editing pipeline, so the change
 * lands on the native undo stack (⌘Z) and fires a normal input event.
 */
const editText = (el: HTMLTextAreaElement, insert: string) => {
  // execCommand is deprecated but is still the only way to keep native undo in a textarea.
  if (insert ? document.execCommand("insertText", false, insert) : document.execCommand("delete")) return
  el.setRangeText(insert, el.selectionStart, el.selectionEnd, "end")
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

/**
 * An editable file: the viewer's own code surface and header, always ready to type in (no edit mode).
 * `base` is the read the current edits started from; `disk` is the latest poll. While nothing is
 * changed, new disk versions are adopted quietly. When they diverge from unsaved changes (an agent
 * wrote the file), or a save is refused as stale, the user picks: overwrite the disk copy or discard
 * their edits.
 */
export const FileEditor = ({
  ticketId,
  disk,
  onDirtyChange,
  header
}: {
  ticketId: string
  disk: FileContent
  onDirtyChange: (dirty: boolean) => void
  /** The viewer's header, with these edit actions in its toolbar. */
  header: (actions: React.ReactNode) => React.ReactNode
}) => {
  const queryClient = useQueryClient()
  const [base, setBase] = useState(disk)
  const [text, setText] = useState(disk.content)
  // The disk version the user chose to keep editing over; don't ask again for it.
  const [dismissed, setDismissed] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const dirty = text !== base.content

  // The parent hears about dirtiness where it changes (edits, save, discard, adoption), not from an
  // Effect watching it; it only needs a final "clean" when the editor goes away.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const edit = (value: string) => {
    setText(value)
    onDirtyChange(value !== base.content)
  }

  const save = useMutation({
    mutationFn: (force: boolean) => api.writeTicketFile(ticketId, { path: base.path, content: text, baseVersion: base.version, force }),
    onSuccess: (saved) => {
      queryClient.setQueryData(qk.ticketFile(ticketId, saved.path), saved)
      void queryClient.invalidateQueries({ queryKey: qk.ticketFiles(ticketId), exact: true })
      setConflict(false)
      setBase(saved)
      setText(saved.content)
      onDirtyChange(false)
      toast.success(`Saved ${saved.path.split("/").at(-1)}`)
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "StaleFile") setConflict(true)
    }
  })

  // React to the file changing on disk underneath the editor.
  useEffect(() => {
    if (disk.version === base.version || save.isPending) return
    // Nothing to lose, or the disk already has exactly our text: adopt the new version quietly.
    if (!dirty || disk.content === text) {
      // oxlint-disable-next-line react/set-state-in-effect -- TODO: reconcile disk versions during render (useEffect cleanup, group B)
      setBase(disk)
      setText(disk.content)
      onDirtyChange(false)
      return
    }
    if (dismissed !== disk.version) setConflict(true)
  }, [disk, base.version, dirty, text, dismissed, save.isPending, onDirtyChange])

  /** Drop unsaved changes and show the newest version on disk. */
  // Read the file fresh: the last poll may predate the write that caused a conflict, and adopting
  // a stale copy would raise the same conflict again as soon as the next poll arrives.
  const discard = useMutation({
    mutationFn: () => api.ticketFile(ticketId, base.path),
    onSuccess: (fresh) => {
      queryClient.setQueryData(qk.ticketFile(ticketId, fresh.path), fresh)
      setConflict(false)
      save.reset()
      setBase(fresh)
      setText(fresh.content)
      setDismissed(undefined)
      onDirtyChange(false)
    }
  })

  const keepEditing = () => {
    setConflict(false)
    setDismissed(disk.version)
    save.reset()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchesChord(e, "mod+s")) {
      e.preventDefault()
      if (dirty && !save.isPending) save.mutate(false)
      return
    }
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: start, selectionEnd: end } = el
      if (e.shiftKey) {
        const lineStart = el.value.lastIndexOf("\n", start - 1) + 1
        if (!el.value.startsWith(INDENT, lineStart)) return
        el.setSelectionRange(lineStart, lineStart + INDENT.length)
        editText(el, "")
        el.setSelectionRange(Math.max(lineStart, start - INDENT.length), Math.max(lineStart, end - INDENT.length))
        return
      }
      editText(el, INDENT)
    }
  }

  return (
    <>
      {header(
        <>
          {save.error && !conflict && (
            <span role="alert" className="max-w-64 truncate text-danger" title={save.error.message}>
              {save.error.message}
            </span>
          )}
          {dirty && <span className="text-warning">Unsaved</span>}
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending || discard.isPending}
              onClick={() => discard.mutate()}
              data-testid="file-discard"
            >
              Discard
            </Button>
          )}
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(false)} data-testid="file-save">
            {save.isPending && <Spinner />}Save <kbd className="ml-1 text-[10px] opacity-60">{formatChord("mod+s")}</kbd>
          </Button>
        </>
      )}
      <CodeSurface
        text={text}
        path={base.path}
        edit={{ label: `Edit ${base.path}`, onChange: edit, onKeyDown }}
        data-testid="file-content"
      />
      <Dialog open={conflict} onOpenChange={(open) => !open && !save.isPending && keepEditing()}>
        <DialogContent
          title="File changed on disk"
          description={`${base.path} was modified since you started editing, probably by an agent.`}
          data-testid="file-conflict"
        >
          <div className="space-y-3 p-4 text-xs text-fg-muted">
            <p>Overwrite it with your version, or discard your changes and load the version on disk.</p>
            {save.error && !(save.error instanceof ApiError && save.error.code === "StaleFile") && (
              <p role="alert" className="text-danger">
                {save.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" disabled={save.isPending} onClick={keepEditing}>
                Keep editing
              </Button>
              <Button
                variant="secondary"
                disabled={save.isPending || discard.isPending}
                onClick={() => discard.mutate()}
                data-testid="file-conflict-discard"
              >
                Discard my changes
              </Button>
              <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(true)} data-testid="file-conflict-overwrite">
                {save.isPending && <Spinner />}Overwrite
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
