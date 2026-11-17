import { Cause, Effect, Exit, Option, Schema } from "effect"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AppError } from "../errors"
import type { AppRuntime, AppServices } from "../runtime"

interface ErrorBody {
  readonly status: ContentfulStatusCode
  readonly error: string
  readonly message: string
  readonly details?: unknown
}

/**
 * Exhaustive, type-checked mapping from every typed daemon failure to an HTTP
 * response. Adding a new error to `AppError` without handling it here is a
 * compile error.
 */
export const toHttpError = (e: AppError): ErrorBody => {
  switch (e._tag) {
    case "NotFound":
      return { status: 404, error: e._tag, message: e.message }
    case "BadRequest":
      return { status: 400, error: e._tag, message: e.message, details: e.details }
    case "Conflict":
      return { status: 409, error: e._tag, message: e.message }
    case "StaleFile":
      return { status: 409, error: e._tag, message: e.message, details: { path: e.path, version: e.version } }
    case "SchemaError":
      return { status: 400, error: "ValidationError", message: e.message }
    case "WorkflowValidationError":
      return { status: 400, error: e._tag, message: e.message, details: e.errors }
    case "HarnessError":
      return {
        status: e.reason === "not_installed" || e.reason === "unsupported" ? 400 : 502,
        error: e._tag,
        message: e.message,
        details: { harness: e.harness, reason: e.reason }
      }
    case "TaskSourceError":
      return {
        status: e.kind === "config" ? 400 : 502,
        error: e._tag,
        message: e.message,
        details: { source: e.source, kind: e.kind, status: e.status }
      }
    case "PullRequestError":
      return { status: 502, error: e._tag, message: e.message }
    case "GitError":
      return { status: 500, error: e._tag, message: e.message, details: { command: e.command } }
    case "DbError":
      return { status: 500, error: e._tag, message: "Database error" }
  }
}

/** A binary response (images); private, immutable content addressed by id or path. */
export class RawBody {
  constructor(
    readonly bytes: Uint8Array,
    readonly contentType: string,
    readonly cacheControl = "private, max-age=31536000, immutable"
  ) {}
}

/**
 * Bridges Hono to the daemon's ManagedRuntime. Each request runs as one
 * Effect with:
 *  - a typed error channel (`AppError`), mapped exhaustively to HTTP;
 *  - a server span named after the route, with method/route/status attributes;
 *  - interruption when the client disconnects (AbortSignal).
 * Defects and interruptions become 500s and are logged with the full Cause.
 */
export const makeResponder = (runtime: AppRuntime) =>
  async <A, E extends AppError>(c: Context, effect: Effect.Effect<A, E, AppServices>, status: ContentfulStatusCode = 200) => {
    const route = c.req.routePath
    const exit = await runtime.runPromiseExit(
      effect.pipe(
        Effect.tapCause((cause) => (Cause.hasDies(cause) ? Effect.logError("request defect", cause) : Effect.void)),
        Effect.withSpan(`HTTP ${c.req.method} ${route}`, {
          kind: "server",
          attributes: { "http.method": c.req.method, "http.route": route, "http.target": c.req.path }
        })
      ),
      { signal: c.req.raw.signal }
    )
    if (Exit.isSuccess(exit)) {
      if (exit.value instanceof RawBody) {
        return c.body(exit.value.bytes as Uint8Array<ArrayBuffer>, status, {
          "content-type": exit.value.contentType,
          "cache-control": exit.value.cacheControl,
          "x-content-type-options": "nosniff"
        })
      }
      return exit.value === undefined ? c.body(null, 204) : c.json(exit.value as object, status)
    }
    const failure = Cause.findErrorOption(exit.cause)
    if (Option.isSome(failure)) {
      const { status: code, ...body } = toHttpError(failure.value)
      return c.json(body, code)
    }
    return c.json({ error: "InternalError", message: Cause.hasInterruptsOnly(exit.cause) ? "Request interrupted" : "Unexpected error" }, 500)
  }

/** Read and validate a JSON body inside Effect; malformed JSON decodes as `{}` and fails validation. */
export const body = <S extends Schema.Top & { readonly DecodingServices: never }>(c: Context, schema: S) =>
  Effect.tryPromise(() => c.req.json() as Promise<unknown>).pipe(
    Effect.orElseSucceed(() => ({})),
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(schema)(raw) as Effect.Effect<S["Type"], Schema.SchemaError>)
  )
