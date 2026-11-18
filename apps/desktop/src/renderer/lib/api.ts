import type {
  ActivityEvent,
  AgentSession,
  Approval,
  ApprovalDecision,
  Artifact,
  CreateSourceConnectionBody,
  CreateProjectBody,
  CreateTicketBody,
  DaemonInfo,
  Diff,
  FileContent,
  FileTree,
  HarnessDetection,
  HarnessId,
  PermissionMode,
  HarnessRateLimits,
  QuestionAnswers,
  HarnessSettings,
  UpdateHarnessSettingsBody,
  ImageRef,
  Project,
  StoredAgentEvent,
  Ticket,
  SourceConnection,
  SourceDescriptor,
  SyncResult,
  UpdateSourceConnectionBody,
  UpdateProjectBody,
  UpdateTicketBody,
  WorkflowDefinitionSummary,
  WorkflowRun,
  WorkflowRunDetail,
  Workspace,
  WriteFileBody
} from "@agentdesk/contracts"
import { type Connection, resolveConnection } from "./connection"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

// React Fast Refresh can replace this module without remounting DaemonGate.
// Keep the already resolved connection across that replacement.
let connection: Connection | null = import.meta.hot?.data.connection ?? null
if (import.meta.hot) import.meta.hot.dispose((data) => { data.connection = connection })
export const setConnection = (c: Connection | null) => {
  connection = c
}
export const getConnection = () => connection

/**
 * The connection is resolved once at startup; if it was lost (e.g. this module was hot-replaced
 * mid-session), resolve it again instead of failing every request until a reload.
 */
const ensureConnection = async () => {
  if (!connection) connection = (await resolveConnection().catch(() => null)) ?? null
  if (!connection) throw new ApiError(0, "NoDaemon", "Not connected to the AgentDesk daemon")
  return connection
}

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  await ensureConnection()
  if (!connection) throw new ApiError(0, "NoDaemon", "Not connected to the AgentDesk daemon")
  let res: Response
  try {
    res = await fetch(connection.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch (e) {
    throw new ApiError(0, "NetworkError", `Daemon unreachable: ${(e as Error).message}`)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const json = text ? JSON.parse(text) : undefined
  if (!res.ok) throw new ApiError(res.status, json?.error ?? "Error", json?.message ?? res.statusText)
  return json as T
}

/** Binary GET (images): the daemon needs the bearer token, which <img src> cannot send. */
const requestBlob = async (path: string): Promise<Blob> => {
  await ensureConnection()
  if (!connection) throw new ApiError(0, "NoDaemon", "Not connected to the AgentDesk daemon")
  const res = await fetch(connection.url + path, { headers: { Authorization: `Bearer ${connection.token}` } })
  if (!res.ok) {
    const json = await res.json().catch(() => undefined)
    throw new ApiError(res.status, json?.error ?? "Error", json?.message ?? res.statusText)
  }
  return res.blob()
}

const toBase64 = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"))
    reader.readAsDataURL(file)
  })

const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  return entries.length ? "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : ""
}

export interface TicketQuery {
  projectId?: string
  source?: string
  status?: string
  q?: string
  pinned?: boolean
  /** true: board tickets only; false: threads only; omitted: both. */
  tracked?: boolean
}

export const api = {
  harnessSettings: () => request<HarnessSettings>("GET", "/settings/harnesses"),
  updateHarnessSettings: (body: UpdateHarnessSettingsBody) => request<HarnessSettings>("PATCH", "/settings/harnesses", body),
  info: () => request<DaemonInfo>("GET", "/info"),
  harnesses: (refresh = false) => request<ReadonlyArray<HarnessDetection>>("GET", `/harnesses/detect${qs({ refresh: refresh ? 1 : undefined })}`),

  projects: () => request<ReadonlyArray<Project>>("GET", "/projects"),
  project: (id: string) => request<Project>("GET", `/projects/${id}`),
  createProject: (b: CreateProjectBody) => request<Project>("POST", "/projects", b),
  updateProject: (id: string, b: UpdateProjectBody) => request<Project>("PATCH", `/projects/${id}`, b),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),

  tickets: (q: TicketQuery = {}) =>
    request<ReadonlyArray<Ticket>>("GET", `/tickets${qs({ ...q, pinned: q.pinned ? 1 : undefined, tracked: q.tracked === undefined ? undefined : q.tracked ? 1 : 0 })}`),
  ticket: (id: string) => request<Ticket>("GET", `/tickets/${id}`),
  createTicket: (b: CreateTicketBody) => request<Ticket>("POST", "/tickets", b),
  updateTicket: (id: string, b: UpdateTicketBody) => request<Ticket>("PATCH", `/tickets/${id}`, b),
  deleteTicket: (id: string) => request<void>("DELETE", `/tickets/${id}`),
  ticketActivity: (id: string) => request<ReadonlyArray<ActivityEvent>>("GET", `/tickets/${id}/activity`),
  ticketSessions: (id: string) => request<ReadonlyArray<AgentSession>>("GET", `/tickets/${id}/sessions`),
  ticketApprovals: (id: string) => request<ReadonlyArray<Approval>>("GET", `/tickets/${id}/approvals`),
  ticketDiff: (id: string) => request<Diff>("GET", `/tickets/${id}/diff`),
  ticketFiles: (id: string) => request<FileTree>("GET", `/tickets/${id}/files`),
  ticketFile: (id: string, path: string) => request<FileContent>("GET", `/tickets/${id}/file${qs({ path })}`),
  writeTicketFile: (id: string, b: WriteFileBody) => request<FileContent>("PUT", `/tickets/${id}/file`, b),
  ticketWorkspace: (id: string) => request<Workspace | null>("GET", `/tickets/${id}/workspace`),
  ticketRuns: (id: string) => request<ReadonlyArray<WorkflowRun>>("GET", `/tickets/${id}/runs`),
  startSession: (ticketId: string, b: { harness?: HarnessId; prompt?: string; images?: ReadonlyArray<string> }) =>
    request<AgentSession>("POST", `/tickets/${ticketId}/sessions`, b),
  startRun: (ticketId: string, b: { workflowId?: string; harness?: HarnessId }) =>
    request<WorkflowRun>("POST", `/tickets/${ticketId}/start-run`, b),
  cleanupWorkspace: (id: string, force = false) =>
    request<Workspace>("POST", `/workspaces/${id}/cleanup${qs({ force: force ? 1 : undefined })}`),

  sessions: (active = false) => request<ReadonlyArray<AgentSession>>("GET", `/sessions${qs({ active: active ? 1 : undefined })}`),
  session: (id: string) => request<AgentSession>("GET", `/sessions/${id}`),
  sessionHistory: (id: string, after = 0) => request<ReadonlyArray<StoredAgentEvent>>("GET", `/sessions/${id}/history${qs({ after })}`),
  /** The newest `tail` events (before `before`, when given), ascending. */
  sessionTail: (id: string, tail: number, before?: number) =>
    request<ReadonlyArray<StoredAgentEvent>>("GET", `/sessions/${id}/history${qs({ tail, before })}`),
  /** `switches` change the session's model/effort from this message on (null: default); omitted keys stay. */
  prompt: (id: string, text: string, images?: ReadonlyArray<string>, switches: { model?: string | null; effort?: string | null; permissionMode?: PermissionMode | null } = {}) =>
    request<void>("POST", `/sessions/${id}/prompt`, { text, ...(images?.length && { images }), ...switches }),
  uploadAttachment: async (file: File) =>
    request<ImageRef>("POST", "/attachments", { mimeType: file.type, data: await toBase64(file), name: file.name || undefined }),
  attachment: (id: string) => requestBlob(`/attachments/${id}`),
  ticketImage: (ticketId: string, path: string) => requestBlob(`/tickets/${ticketId}/raw${qs({ path })}`),
  interrupt: (id: string) => request<void>("POST", `/sessions/${id}/interrupt`),
  stopSession: (id: string) => request<void>("POST", `/sessions/${id}/stop`),

  approvals: (pending = false) => request<ReadonlyArray<Approval>>("GET", `/approvals${qs({ pending: pending ? 1 : undefined })}`),
  decide: (
    id: string,
    decision: ApprovalDecision,
    options: { note?: string; scope?: "once" | "session"; answers?: QuestionAnswers } = {}
  ) => request<void>("POST", `/approvals/${id}/decision`, { decision, ...options }),
  limits: () => request<ReadonlyArray<HarnessRateLimits>>("GET", "/limits"),

  activity: (limit = 100) => request<ReadonlyArray<ActivityEvent>>("GET", `/activity${qs({ limit })}`),

  runs: (status?: string) => request<ReadonlyArray<WorkflowRun>>("GET", `/runs${qs({ status })}`),
  run: (id: string) => request<WorkflowRunDetail>("GET", `/runs/${id}`),
  cancelRun: (id: string) => request<void>("POST", `/runs/${id}/cancel`),
  resumeRun: (id: string) => request<void>("POST", `/runs/${id}/resume`),
  retryStep: (id: string) => request<void>("POST", `/runs/${id}/retry`),
  artifact: (id: string) => request<Artifact>("GET", `/artifacts/${id}`),

  workflows: () => request<ReadonlyArray<WorkflowDefinitionSummary>>("GET", "/workflows"),
  workflow: (id: string) => request<WorkflowDefinitionSummary & { versions: ReadonlyArray<number> }>("GET", `/workflows/${id}`),
  saveWorkflow: (yaml: string) => request<WorkflowDefinitionSummary>("POST", "/workflows", { yaml }),
  validateWorkflow: (yaml: string) =>
    request<{ ok: boolean; errors: ReadonlyArray<string> }>("POST", "/workflows/validate", { yaml }),

  sources: () => request<ReadonlyArray<SourceDescriptor>>("GET", "/sources"),
  sourceConnections: () => request<ReadonlyArray<SourceConnection>>("GET", "/sources/connections"),
  createSourceConnection: (b: CreateSourceConnectionBody) => request<SourceConnection>("POST", "/sources/connections", b),
  updateSourceConnection: (id: string, b: UpdateSourceConnectionBody) =>
    request<SourceConnection>("PATCH", `/sources/connections/${id}`, b),
  deleteSourceConnection: (id: string) => request<void>("DELETE", `/sources/connections/${id}`),
  syncSource: (id: string, full = false) =>
    request<SyncResult>("POST", `/sources/connections/${id}/sync${qs({ full: full ? 1 : undefined })}`),
  testSource: (id: string) => request<{ ok: boolean; message: string }>("POST", `/sources/connections/${id}/test`)
}
