import type { ImageRef } from "@agentdesk/contracts"
import { useQuery } from "@tanstack/react-query"
import { ImageOff, LoaderCircle } from "lucide-react"
import { useEffect, useState } from "react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

/** Object URL for a blob, revoked when the component unmounts or the blob changes. */
export const useObjectUrl = (blob: Blob | undefined) => {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!blob) return setUrl(undefined)
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

/** Attachments are content-addressed, so their bytes never change: cache them for the session. */
const useAttachmentBlob = (id: string) =>
  useQuery({ queryKey: ["attachments", id], queryFn: () => api.attachment(id), staleTime: Infinity, gcTime: 10 * 60_000 })

/** A stored image (prompt attachment or agent screenshot); click to view full size. */
export const AttachmentImage = ({ image, className }: { image: ImageRef; className?: string }) => {
  const blob = useAttachmentBlob(image.id)
  const url = useObjectUrl(blob.data)
  return <ImageFrame url={url} loading={blob.isLoading} failed={!!blob.error} name={image.name} className={className} />
}

export const ImageFrame = ({
  url,
  loading,
  failed,
  name,
  className
}: {
  url: string | undefined
  loading?: boolean
  failed?: boolean
  name?: string
  className?: string
}) => {
  const [open, setOpen] = useState(false)
  if (failed || (!loading && !url)) {
    return (
      <div className={cn("flex size-24 items-center justify-center rounded-xl border bg-muted text-muted-foreground", className)} title="Image unavailable">
        <ImageOff className="size-4" />
      </div>
    )
  }
  if (!url) {
    return (
      <div className={cn("flex size-24 items-center justify-center rounded-xl border bg-muted text-muted-foreground", className)}>
        <LoaderCircle className="size-4 animate-spin" />
      </div>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn("block overflow-hidden rounded-xl border bg-muted transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none", className)}
        title={name ?? "View image"}
      >
        <img src={url} alt={name ?? "Image"} className="block max-h-80 w-auto max-w-full object-contain" draggable={false} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={name ?? "Image"} className="top-[5%] w-auto max-w-[92vw]">
          <div className="flex max-h-[82vh] items-center justify-center overflow-auto bg-bg p-3">
            <img src={url} alt={name ?? "Image"} className="max-h-[78vh] max-w-full object-contain" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
