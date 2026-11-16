import { Effect, Stream } from "effect"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AppRuntime, AppServices } from "../runtime"

/**
 * Pipe an Effect Stream into a Server-Sent Events response. The stream is
 * interrupted when the client disconnects. A heartbeat comment keeps proxies
 * and idle timers from closing the connection.
 */
export const sseFromStream = <A, E>(
  c: Context,
  runtime: AppRuntime,
  stream: Stream.Stream<A, E, AppServices>,
  encode: (a: A) => { id?: string; event?: string; data: string }
) =>
  streamSSE(c, async (sse) => {
    const controller = new AbortController()
    sse.onAbort(() => controller.abort())
    const heartbeat = setInterval(() => {
      void sse.write(": ping\n\n").catch(() => controller.abort())
    }, 15_000)
    try {
      await sse.writeSSE({ event: "ready", data: "{}" })
      await runtime.runPromise(
        stream.pipe(Stream.runForEach((a) => Effect.promise(() => sse.writeSSE(encode(a))))),
        { signal: controller.signal }
      )
    } catch {
      /* client went away or stream failed; connection closes */
    } finally {
      clearInterval(heartbeat)
    }
  })
