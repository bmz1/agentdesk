import { type HarnessAdapter, NodeProcessLayer } from "@agentdesk/harness-core"
import { Layer, ManagedRuntime } from "effect"
import { DaemonConfigLive, type DaemonConfigShape } from "./config"
import { ObservabilityLive } from "./observability"
import { Activity } from "./services/activity"
import { ApprovalsLive } from "./services/approvals"
import { AttachmentsLive } from "./services/attachments"
import { CredentialStoreLive } from "./services/credentials"
import { Database } from "./services/database"
import { EventLog } from "./services/event-log"
import { HarnessSettings } from "./services/harness-settings"
import { HarnessesLive } from "./services/harnesses"
import { TaskSourcesLive, TaskSyncLive, type TaskSyncOptions } from "./services/task-sync"
import type { TaskSourceAdapter } from "@agentdesk/task-source"
import { Maintenance } from "./services/maintenance"
import { Notices } from "./services/notices"
import { ProjectsLive } from "./services/projects"
import { SessionsLive } from "./services/sessions"
import { TicketsLive } from "./services/tickets"
import { WorkflowsLive, type WorkflowsOptions } from "./services/workflows"
import { WorkspacesLive } from "./services/workspaces"

export interface AppLayerOptions {
  readonly adapters?: ReadonlyArray<HarnessAdapter>
  /** Connection options (e.g. injected fetch) passed to every task source. */
  readonly sources?: TaskSyncOptions
  /** Override the registered task sources (default: Jira, Linear). */
  readonly sourceAdapters?: ReadonlyArray<TaskSourceAdapter<any>>
  /** "memory" keeps secrets in-process only (tests). */
  readonly credentialStore?: "auto" | "memory"
  readonly workflows?: WorkflowsOptions
}

/**
 * The daemon's explicit dependency graph, from platform services
 * (process spawner, config, observability) up to the workflow engine.
 */
export const makeAppLayer = (config: DaemonConfigShape, options: AppLayerOptions = {}) => {
  const platform = Layer.mergeAll(DaemonConfigLive(config), NodeProcessLayer, ObservabilityLive(config))
  const base = Layer.mergeAll(Database.layer, Notices.layer).pipe(Layer.provideMerge(platform))
  const infra = Layer.mergeAll(
    EventLog.layer,
    HarnessSettings.layer,
    Activity.layer,
    AttachmentsLive,
    CredentialStoreLive(options.credentialStore),
    TaskSourcesLive(options.sourceAdapters)
  ).pipe(
    Layer.provideMerge(base)
  )
  const domain = Layer.mergeAll(
    ProjectsLive,
    TicketsLive,
    ApprovalsLive,
    WorkspacesLive,
    HarnessesLive(options.adapters),
    TaskSyncLive(options.sources),
    Maintenance.layer
  ).pipe(Layer.provideMerge(infra))
  const sessions = SessionsLive.pipe(Layer.provideMerge(domain))
  return WorkflowsLive(options.workflows).pipe(Layer.provideMerge(sessions))
}

export type AppLayer = ReturnType<typeof makeAppLayer>
export type AppServices = Layer.Success<AppLayer>
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, Layer.Error<AppLayer>>

export const makeRuntime = (config: DaemonConfigShape, options: AppLayerOptions = {}): AppRuntime =>
  ManagedRuntime.make(makeAppLayer(config, options))
