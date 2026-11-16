import { ArrowUp, Square } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/input"
import { Kbd, Spinner } from "@/components/ui/misc"

export const Composer = ({
  onSend,
  onInterrupt,
  running,
  disabled,
  placeholder
}: {
  onSend: (text: string) => Promise<unknown>
  onInterrupt?: () => void
  running?: boolean
  disabled?: boolean
  placeholder?: string
}) => {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const send = async () => {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      await onSend(t)
      setText("")
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4">
      <div className="rounded-lg border bg-bg-elevated focus-within:border-accent/60">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          rows={3}
          disabled={disabled}
          placeholder={placeholder ?? "Send a follow-up to the agent…"}
          className="border-0 bg-transparent focus:ring-0"
          data-testid="composer-input"
        />
        <div className="flex items-center justify-between px-2 pb-2">
          <span className="text-[11px] text-fg-subtle">
            <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send
          </span>
          <div className="flex gap-1.5">
            {running && onInterrupt && (
              <Button size="sm" variant="secondary" onClick={onInterrupt}>
                <Square />
                Interrupt
              </Button>
            )}
            <Button size="sm" onClick={() => void send()} disabled={disabled || sending || !text.trim()} data-testid="composer-send">
              {sending ? <Spinner /> : <ArrowUp />}
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
