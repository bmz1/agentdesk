import type { HarnessAdapter } from "@agentdesk/harness-core"
import { Layer, ManagedRuntime } from "effect"
import { DaemonConfigLive, type DaemonConfigShape, makeConfig } from "./config"
import { fileLoggerLayer } from "./logging"
import { ActivityLive } from "./services/activity"
import { ApprovalsLive } from "./services/approvals"
import { DatabaseLive } from "./services/database"
import { CredentialStoreLive } from "./services/credentials"
import { EventLogLive } from "./services/event-log"
import { HarnessesLive } from "./services/harnesses"
import { MaintenanceLive } from "./services/maintenance"
import { JiraSyncLive, type JiraSyncOptions } from "./services/jira-sync"
import { NoticesLive } from "./services/notices"
import { ProjectsLive } from "./services/projects"
import { SessionsLive } from "./services/sessions"
import { TicketsLive } from "./services/tickets"
import { WorkflowsLive, type WorkflowsOptions } from "./services/workflows"
import { WorkspacesLive } from "./services/workspaces"

export interface AppLayerOptions {
  readonly config?: Partial<DaemonConfigShape>
  readonly adapters?: ReadonlyArray<HarnessAdapter>
  readonly jira?: JiraSyncOptions
  /** "memory" keeps secrets in-process only (tests). */
  readonly credentialStore?: "auto" | "memory"
  readonly workflows?: WorkflowsOptions
}

/** The daemon's explicit dependency graph. */
export const makeAppLayer = (options: AppLayerOptions = {}) => {
  const resolved = makeConfig(options.config)
  const config = Layer.merge(DaemonConfigLive(resolved), fileLoggerLayer(resolved.logFile))
  const base = Layer.mergeAll(DatabaseLive, NoticesLive).pipe(Layer.provideMerge(config))
  const infra = Layer.mergeAll(EventLogLive, ActivityLive, CredentialStoreLive(options.credentialStore)).pipe(
    Layer.provideMerge(base)
  )
  const domain = Layer.mergeAll(
    ProjectsLive,
    TicketsLive,
    ApprovalsLive,
    WorkspacesLive,
    HarnessesLive(options.adapters),
    JiraSyncLive(options.jira),
    MaintenanceLive
  ).pipe(Layer.provideMerge(infra))
  const sessions = SessionsLive.pipe(Layer.provideMerge(domain))
  return WorkflowsLive(options.workflows).pipe(Layer.provideMerge(sessions))
}

export type AppLayer = ReturnType<typeof makeAppLayer>
export type AppServices = Layer.Success<AppLayer>
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>

export const makeRuntime = (options: AppLayerOptions = {}): AppRuntime =>
  ManagedRuntime.make(makeAppLayer(options) as Layer.Layer<AppServices, never, never>)
