import type { AgentEvent, HarnessId } from "@agentdesk/contracts"
import { Cause, Effect, Queue, Scope, Stream } from "effect"
import type { HarnessError } from "./errors"
import { parseJsonLine } from "./json"
import type { ManagedProcess } from "./process"

/** Pure, stateful translator from native protocol messages to canonical events. */
export interface Normalizer {
  push(message: unknown): ReadonlyArray<AgentEvent>
}

export interface LineSessionPlumbing {
  readonly events: Queue.Queue<AgentEvent, HarnessError | Cause.Done>
  readonly emit: (e: AgentEvent) => Effect.Effect<void>
}

/**
 * Wires a JSONL-speaking process to a canonical event queue:
 * every stdout line is parsed, offered to `onMessage` (for protocol replies like
 * JSON-RPC responses) and normalized. When the process exits a
 * `session.exited` event is emitted and the queue ends.
 */
export const wireLineProcess = (opts: {
  readonly harness: HarnessId
  readonly process: ManagedProcess
  readonly normalizer: Normalizer
  readonly onMessage?: (message: unknown) => Effect.Effect<boolean>
}): Effect.Effect<LineSessionPlumbing, never, Scope.Scope> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<AgentEvent, HarnessError | Cause.Done>()
    const emit = (e: AgentEvent) => Queue.offer(events, e).pipe(Effect.asVoid)

    yield* opts.process.lines.pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const message = parseJsonLine(line)
          if (message === undefined) return
          const handled = opts.onMessage ? yield* opts.onMessage(message) : false
          if (handled) return
          for (const e of opts.normalizer.push(message)) yield* emit(e)
        })
      ),
      Effect.andThen(opts.process.exited),
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          if (exit.code !== 0 && exit.code !== null) {
            const tail = opts.process.stderrTail().trim().split("\n").slice(-5).join("\n")
            if (tail) yield* emit({ type: "session.error", message: tail })
          }
          yield* emit({ type: "session.exited", code: exit.code, signal: exit.signal })
        })
      ),
      Effect.ensuring(Queue.end(events)),
      Effect.forkScoped
    )

    return { events, emit }
  })

export const eventsStream = (q: Queue.Queue<AgentEvent, HarnessError | Cause.Done>): Stream.Stream<AgentEvent, HarnessError> =>
  Stream.fromQueue(q)
