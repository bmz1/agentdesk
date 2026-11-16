import { timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import type { DaemonConfigShape } from "../config"

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Local API hardening:
 *  - Host header must be loopback (defeats DNS rebinding).
 *  - Origin, when present, must be allow-listed (CORS + CSRF).
 *  - Every request needs the per-install bearer token.
 */
export const securityMiddleware = (config: DaemonConfigShape): MiddlewareHandler => async (c, next) => {
  const host = (c.req.header("host") ?? "").toLowerCase()
  const hostname = host.replace(/:\d+$/, "")
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname)) {
    return c.json({ error: "Forbidden", message: "Invalid Host header" }, 403)
  }
  const origin = c.req.header("origin")
  const originAllowed =
    origin === undefined || config.allowedOrigins.some((o) => o === origin || (o.endsWith("://") && origin.startsWith(o)))
  if (!originAllowed) return c.json({ error: "Forbidden", message: "Origin not allowed" }, 403)
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin)
    c.header("Vary", "Origin")
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
    c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
    c.header("Access-Control-Max-Age", "600")
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204)
  if (c.req.path === "/health") return next()
  const auth = c.req.header("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  if (!token || !safeEqual(token, config.token)) {
    return c.json({ error: "Unauthorized", message: "Missing or invalid API token" }, 401)
  }
  c.header("Cache-Control", "no-store")
  c.header("X-Content-Type-Options", "nosniff")
  return next()
}
