import { Effect, Stream } from "effect"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AppRuntime, AppServices } from "../runtime"

/**
 * Pipe an Effect Stream into a Server-Sent Events response on the
 * ManagedRuntime. The stream fiber is interrupted when the client disconnects;
 * a heartbeat (scheduled on the Effect clock) keeps idle connections open.
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
    const write = (m: { id?: string; event?: string; data: string }) => Effect.promise(() => sse.writeSSE(m))
    const heartbeat = Stream.tick("15 seconds").pipe(Stream.mapEffect(() => Effect.promise(() => sse.write(": ping\n\n"))))
    await runtime
      .runPromiseExit(
        write({ event: "ready", data: "{}" }).pipe(
          Effect.andThen(
            Stream.merge(stream.pipe(Stream.mapEffect((a) => write(encode(a)))), heartbeat, { haltStrategy: "left" }).pipe(Stream.runDrain)
          ),
          Effect.withSpan(`SSE ${c.req.routePath}`, { kind: "server", attributes: { "http.route": c.req.routePath } })
        ),
        { signal: controller.signal }
      )
  })
