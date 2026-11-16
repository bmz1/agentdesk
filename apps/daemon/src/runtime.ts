import type { HarnessAdapter } from "@agentdesk/harness-core"
import { Layer, ManagedRuntime } from "effect"
import { DaemonConfigLive, type DaemonConfigShape } from "./config"
import { ActivityLive } from "./services/activity"
import { ApprovalsLive } from "./services/approvals"
import { DatabaseLive } from "./services/database"
import { EventLogLive } from "./services/event-log"
import { HarnessesLive } from "./services/harnesses"
import { NoticesLive } from "./services/notices"
import { ProjectsLive } from "./services/projects"
import { SessionsLive } from "./services/sessions"
import { TicketsLive } from "./services/tickets"
import { WorkspacesLive } from "./services/workspaces"

export interface AppLayerOptions {
  readonly config?: Partial<DaemonConfigShape>
  readonly adapters?: ReadonlyArray<HarnessAdapter>
}

/** The daemon's explicit dependency graph. */
export const makeAppLayer = (options: AppLayerOptions = {}) => {
  const config = DaemonConfigLive(options.config)
  const base = Layer.mergeAll(DatabaseLive, NoticesLive).pipe(Layer.provideMerge(config))
  const infra = Layer.mergeAll(EventLogLive, ActivityLive).pipe(Layer.provideMerge(base))
  const domain = Layer.mergeAll(
    ProjectsLive,
    TicketsLive,
    ApprovalsLive,
    WorkspacesLive,
    HarnessesLive(options.adapters)
  ).pipe(Layer.provideMerge(infra))
  return SessionsLive.pipe(Layer.provideMerge(domain))
}

export type AppLayer = ReturnType<typeof makeAppLayer>
export type AppServices = Layer.Success<AppLayer>
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>

export const makeRuntime = (options: AppLayerOptions = {}): AppRuntime =>
  ManagedRuntime.make(makeAppLayer(options) as Layer.Layer<AppServices, never, never>)
