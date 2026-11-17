import type { ChangeNotice } from "@agentdesk/contracts"
import { Context, Effect, Layer, PubSub, Stream } from "effect"

/** Coarse-grained invalidation notices so UIs can refetch without polling. */
export interface NoticesShape {
  readonly publish: (n: ChangeNotice) => Effect.Effect<void>
  readonly stream: Stream.Stream<ChangeNotice>
}

export class Notices extends Context.Service<Notices, NoticesShape>()("agentdesk/Notices") {
  static readonly layer = Layer.effect(
    Notices,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.sliding<ChangeNotice>(1024)
      return Notices.of({
        publish: (n) => PubSub.publish(pubsub, n).pipe(Effect.asVoid),
        stream: Stream.fromPubSub(pubsub)
      })
    })
  )
}
