import { Cause, Effect, Exit, Schema } from "effect"
import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AppRuntime, AppServices } from "../runtime"

interface Mapped {
  status: ContentfulStatusCode
  error: string
  message: string
  details?: unknown
}

export const mapError = (err: unknown): Mapped => {
  const tag = typeof err === "object" && err !== null && "_tag" in err ? String((err as { _tag: unknown })._tag) : undefined
  const message =
    typeof err === "object" && err !== null && "message" in err ? String((err as { message: unknown }).message) : String(err)
  switch (tag) {
    case "NotFound":
      return { status: 404, error: tag, message }
    case "BadRequest":
      return { status: 400, error: tag, message, details: (err as { details?: unknown }).details }
    case "Conflict":
      return { status: 409, error: tag, message }
    case "SchemaError":
      return { status: 400, error: "ValidationError", message }
    case "HarnessError": {
      const reason = (err as { reason?: string }).reason
      return { status: reason === "not_installed" || reason === "unsupported" ? 400 : 502, error: tag, message, details: { reason } }
    }
    case "GitError":
      return { status: 500, error: tag, message }
    case "JiraError":
      return { status: 502, error: tag, message }
    default:
      return { status: 500, error: tag ?? "InternalError", message }
  }
}

export const makeResponder = (runtime: AppRuntime) => {
  const respond = async <A>(
    c: Context,
    effect: Effect.Effect<A, unknown, AppServices>,
    status: ContentfulStatusCode = 200
  ): Promise<Response> => {
    const exit = await runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) {
      if (exit.value === undefined) return c.body(null, 204)
      return c.json(exit.value as object, status)
    }
    const err = Cause.squash(exit.cause)
    const mapped = mapError(err)
    if (mapped.status >= 500) {
      await runtime.runPromise(Effect.logError("request failed", Cause.pretty(exit.cause)))
    }
    return c.json({ error: mapped.error, message: mapped.message, details: mapped.details }, mapped.status)
  }
  return respond
}

/** Parse + validate a JSON body against an Effect Schema. */
export const body = async <S extends Schema.Top & { readonly DecodingServices: never }>(
  c: Context,
  schema: S
): Promise<Effect.Effect<S["Type"], Schema.SchemaError>> => {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    raw = {}
  }
  return Schema.decodeUnknownEffect(schema)(raw) as Effect.Effect<S["Type"], Schema.SchemaError>
}
