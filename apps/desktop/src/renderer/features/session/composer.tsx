import type { ImageRef } from "@agentdesk/contracts"
import { ArrowUp, ImagePlus, LoaderCircle, Square, TriangleAlert, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const MAX_BYTES = 10 * 1024 * 1024

interface Pending {
  readonly key: string
  readonly preview: string
  readonly name: string
  ref?: ImageRef
  error?: string
}

/** Prompt form in the shape of the shadcn chatbot template, with image attachments. */
export const Composer = ({
  onSend,
  onInterrupt,
  running,
  disabled,
  placeholder,
  meta
}: {
  onSend: (text: string, images: ReadonlyArray<string>) => Promise<unknown>
  onInterrupt?: () => void
  running?: boolean
  disabled?: boolean
  placeholder?: string
  /** Shown on the left of the actions row (e.g. harness and state). */
  meta?: React.ReactNode
}) => {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [images, setImages] = useState<Array<Pending>>([])
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Revoke previews on unmount.
  const latest = useRef(images)
  latest.current = images
  useEffect(() => () => latest.current.forEach((i) => URL.revokeObjectURL(i.preview)), [])

  const addFiles = (files: Iterable<File>) => {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) continue
      const key = crypto.randomUUID()
      const item: Pending = { key, preview: URL.createObjectURL(file), name: file.name || "pasted image" }
      if (file.size > MAX_BYTES) item.error = "Larger than 10 MB"
      setImages((prev) => [...prev, item])
      if (item.error) continue
      api
        .uploadAttachment(file)
        .then((ref) => setImages((prev) => prev.map((p) => (p.key === key ? { ...p, ref } : p))))
        .catch((e: Error) => setImages((prev) => prev.map((p) => (p.key === key ? { ...p, error: e.message } : p))))
    }
  }
  const remove = (key: string) =>
    setImages((prev) => {
      const gone = prev.find((p) => p.key === key)
      if (gone) URL.revokeObjectURL(gone.preview)
      return prev.filter((p) => p.key !== key)
    })

  const uploading = images.some((i) => !i.ref && !i.error)
  const ready = images.filter((i) => i.ref)
  const canSend = !disabled && !sending && !uploading && (text.trim().length > 0 || ready.length > 0)

  const send = async () => {
    if (!canSend) return
    const t = text.trim() || (ready.length === 1 ? "See the attached image." : "See the attached images.")
    setSending(true)
    try {
      await onSend(
        t,
        ready.map((i) => i.ref!.id)
      )
      setText("")
      images.forEach((i) => URL.revokeObjectURL(i.preview))
      setImages([])
    } finally {
      setSending(false)
    }
  }

  return (
    <form
      className="mx-auto w-full max-w-3xl px-6 pb-5"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        setDragging(false)
        if (disabled || e.dataTransfer.files.length === 0) return
        e.preventDefault()
        addFiles(e.dataTransfer.files)
      }}
    >
      <InputGroup
        className={cn(
          // No focus ring or border change when the input is clicked; the caret is enough.
          "rounded-2xl border-border bg-bg-elevated has-[[data-slot=input-group-control]:focus-visible]:border-border has-[[data-slot=input-group-control]:focus-visible]:ring-0",
          dragging && "border-primary ring-3 ring-ring/30"
        )}
      >
        {images.length > 0 && (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2 pt-3">
            {images.map((img) => (
              <div key={img.key} className="group/thumb relative size-16 shrink-0" title={img.error ?? img.name}>
                <img
                  src={img.preview}
                  alt={img.name}
                  className={cn("size-16 rounded-lg border object-cover", (!img.ref || img.error) && "opacity-50")}
                />
                {!img.ref && !img.error && <LoaderCircle className="absolute inset-0 m-auto size-4 animate-spin text-foreground" />}
                {img.error && <TriangleAlert className="absolute inset-0 m-auto size-4 text-danger" />}
                <button
                  type="button"
                  onClick={() => remove(img.key)}
                  aria-label={`Remove ${img.name}`}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-bg-elevated text-muted-foreground opacity-0 shadow-sm group-hover/thumb:opacity-100 hover:text-foreground focus-visible:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => IMAGE_TYPES.includes(f.type))
            if (files.length === 0) return
            e.preventDefault()
            addFiles(files)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={placeholder ?? "Send a follow-up to the agent… (paste or drop screenshots)"}
          className="max-h-60 min-h-14 p-3.5 text-[14px] focus:ring-0"
          data-testid="composer-input"
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Attach images"
            title="Attach images"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus />
          </InputGroupButton>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_TYPES.join(",")}
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <InputGroupText className="min-w-0 truncate text-xs font-normal text-fg-subtle">{meta}</InputGroupText>
          <div className="ml-auto flex items-center gap-1.5">
            {running && onInterrupt && (
              <InputGroupButton type="button" size="icon-sm" variant="outline" aria-label="Interrupt the agent" title="Interrupt" onClick={onInterrupt}>
                <Square />
              </InputGroupButton>
            )}
            <InputGroupButton type="submit" size="icon-sm" variant="default" aria-label="Send message" disabled={!canSend} data-testid="composer-send">
              {sending || uploading ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
