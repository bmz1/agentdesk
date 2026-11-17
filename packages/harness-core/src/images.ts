import type { AgentEvent } from "@agentdesk/contracts"
import { isRecord, str } from "./json"

export interface InlineImage {
  readonly data: string
  readonly mimeType: string
}

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.+)$/s

/**
 * Recognises an image content block in the shapes harnesses use:
 *  - Anthropic: `{ type: "image", source: { type: "base64", media_type, data } }`
 *  - MCP:       `{ type: "image", data, mimeType }`
 *  - OpenCode:  `{ type: "file", mime, url: "data:image/...;base64,..." }`
 */
export const asInlineImage = (block: unknown): InlineImage | undefined => {
  if (!isRecord(block)) return undefined
  if (block.type === "image") {
    const source = isRecord(block.source) ? block.source : undefined
    if (source && source.type === "base64" && str(source.data)) {
      return { data: str(source.data)!, mimeType: str(source.media_type) ?? "image/png" }
    }
    if (str(block.data)) return { data: str(block.data)!, mimeType: str(block.mimeType) ?? str(block.mime_type) ?? "image/png" }
  }
  const url = str(block.url)
  const m = url ? DATA_URL.exec(url) : null
  if (m && (block.type === "file" || block.type === "image")) return { data: m[2]!, mimeType: m[1]! }
  return undefined
}

/**
 * Splits images out of a tool result so base64 never lands in the event log as
 * text. Returns the result without image blocks and the images found.
 */
export const extractImages = (content: unknown): { rest: unknown; images: ReadonlyArray<InlineImage> } => {
  const list = Array.isArray(content) ? content : isRecord(content) && Array.isArray(content.content) ? content.content : undefined
  if (!list) return { rest: content, images: [] }
  const images: Array<InlineImage> = []
  const kept = list.filter((b) => {
    const img = asInlineImage(b)
    if (img) images.push(img)
    return !img
  })
  if (images.length === 0) return { rest: content, images }
  const rest = Array.isArray(content) ? kept : { ...(content as Record<string, unknown>), content: kept }
  return { rest, images }
}

export const imageEvents = (images: ReadonlyArray<InlineImage>, toolCallId?: string): Array<AgentEvent> =>
  images.map((img) => ({ type: "image", ...(toolCallId && { toolCallId }), source: { data: img.data, mimeType: img.mimeType } }))
