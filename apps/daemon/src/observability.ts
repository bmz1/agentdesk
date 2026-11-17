import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"
import type { DaemonConfigShape } from "./config"
import { fileLoggerLayer } from "./logging"

/**
 * Logging + tracing for the daemon. Spans from `Effect.fn` / `withSpan` are
 * exported over OTLP/HTTP (JSON) when OTEL_EXPORTER_OTLP_ENDPOINT is set, e.g.
 * to a local Jaeger/Tempo/Honeycomb collector; logs always go to the redacted
 * JSON-lines file.
 */
export const ObservabilityLive = (config: DaemonConfigShape) => {
  const logs = fileLoggerLayer(config.logFile)
  if (!config.otlpEndpoint) return logs
  const otlp = Otlp.layerJson({
    baseUrl: config.otlpEndpoint,
    resource: { serviceName: "agentdesk-daemon", serviceVersion: config.version },
    loggerMergeWithExisting: true
  }).pipe(Layer.provide(FetchHttpClient.layer))
  return Layer.merge(logs, otlp)
}
