import type { AgentSession, Approval, ChangeNotice, Project, StoredAgentEvent, Ticket } from "@agentdesk/contracts"
import { CliError, type Client, Exit } from "./client"

export interface Output {
  readonly json: boolean
  readonly write: (line: string) => void
}

const WORKING: ReadonlyArray<AgentSession["state"]> = ["starting", "running"]

const ambiguous = (kind: string, query: string, matches: ReadonlyArray<string>) =>
  new CliError(`"${query}" matches ${matches.length} ${kind}s:\n  ${matches.join("\n  ")}`, Exit.target, { matches })

/**
 * Find one item by full id, then by an extra key (ticket identifier, project key), then by a
 * unique id prefix of at least 4 characters. Ambiguity changes nothing and exits 3.
 */
export const resolveOne = <T extends { id: string }>(
  kind: string,
  query: string,
  items: ReadonlyArray<T>,
  key?: (item: T) => string | undefined
): T => {
  const exact = items.find((i) => i.id === query)
  if (exact) return exact
  const keyed = key ? items.filter((i) => key(i)?.toLowerCase() === query.toLowerCase()) : []
  if (keyed.length === 1) return keyed[0]!
  if (keyed.length > 1) throw ambiguous(kind, query, keyed.map((i) => i.id))
  const prefixed = query.length >= 4 ? items.filter((i) => i.id.startsWith(query)) : []
  if (prefixed.length === 1) return prefixed[0]!
  if (prefixed.length > 1) throw ambiguous(kind, query, prefixed.map((i) => i.id))
  throw new CliError(`No ${kind} matches "${query}"`, Exit.target)
}

/** A session by id, id prefix, or the identifier of its ticket (`AD-12` → that ticket's current session). */
export const resolveSession = async (client: Client, query: string): Promise<AgentSession> => {
  const sessions = await client.get<ReadonlyArray<AgentSession>>("/sessions")
  const exact = sessions.find((s) => s.id === query)
  if (exact) return exact
  if (/^[a-z][a-z0-9]*-\d+$/i.test(query)) {
    const tickets = await client.get<ReadonlyArray<Ticket>>("/tickets")
    const ticket = tickets.find((t) => t.identifier.toLowerCase() === query.toLowerCase())
    if (ticket) {
      const own = await client.get<ReadonlyArray<AgentSession>>(`/tickets/${ticket.id}/sessions`)
      const current = own.find((s) => s.id === ticket.activeSessionId) ?? own[0]
      if (!current) throw new CliError(`${ticket.identifier} has no agent session yet`, Exit.target)
      return current
    }
  }
  return resolveOne("session", query, sessions)
}

const ticketLabels = async (client: Client) => {
  const tickets = await client.get<ReadonlyArray<Ticket>>("/tickets")
  return new Map(tickets.map((t) => [t.id, t]))
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))

const sessionLine = (s: AgentSession, ticket?: Ticket) =>
  [pad(s.id, 36), pad(s.state, 20), pad(ticket?.identifier ?? "", 9), pad(ticket?.title ?? "", 32), s.statusDetail ?? ""]
    .join("  ")
    .trimEnd()

export const status = async (client: Client, out: Output) => {
  const info = await client.get<Record<string, unknown>>("/info")
  if (out.json) out.write(JSON.stringify(info))
  else for (const [k, v] of Object.entries(info)) out.write(`${pad(k, 15)} ${String(v)}`)
  return Exit.ok
}

export const ls = async (client: Client, out: Output, opts: { active?: boolean; attention?: boolean }) => {
  const [sessions, pending] = await Promise.all([
    client.get<ReadonlyArray<AgentSession>>(`/sessions${opts.active ? "?active=1" : ""}`),
    opts.attention ? client.get<ReadonlyArray<Approval>>("/approvals?pending=1") : Promise.resolve([])
  ])
  const blocked = new Set(pending.map((a) => a.sessionId))
  const shown = opts.attention
    ? sessions.filter((s) => blocked.has(s.id) || s.state === "waiting_for_approval" || s.state === "failed")
    : sessions
  if (out.json) {
    out.write(JSON.stringify(shown))
    return Exit.ok
  }
  const tickets = await ticketLabels(client)
  for (const s of shown) out.write(sessionLine(s, tickets.get(s.ticketId)))
  return Exit.ok
}

export const show = async (client: Client, out: Output, query: string) => {
  const session = await resolveSession(client, query)
  if (out.json) out.write(JSON.stringify(session))
  else {
    const ticket = (await ticketLabels(client)).get(session.ticketId)
    out.write(sessionLine(session, ticket))
    if (session.preview) out.write(`\n${session.preview}`)
  }
  return Exit.ok
}

export const projects = async (client: Client, out: Output) => {
  const list = await client.get<ReadonlyArray<Project>>("/projects")
  if (out.json) out.write(JSON.stringify(list))
  else for (const p of list) out.write(`${pad(p.id, 36)}  ${pad(p.key, 6)}  ${pad(p.name, 24)}  ${p.repoPath}`)
  return Exit.ok
}

export interface NewOptions {
  readonly project?: string
  readonly title?: string
  readonly harness?: string
  readonly wait?: boolean
  readonly timeoutSec?: number
}

/** Start a thread: a ticket kept off the board, with an agent session on the prompt. */
export const newThread = async (client: Client, out: Output, prompt: string, opts: NewOptions, cwd = process.cwd()) => {
  const list = await client.get<ReadonlyArray<Project>>("/projects")
  const project = opts.project
    ? resolveOne("project", opts.project, list, (p) => p.key)
    : list.find((p) => cwd === p.repoPath || cwd.startsWith(p.repoPath + "/"))
  if (!project) throw new CliError("No project for this directory; pass --project <key|id> (see `agentdesk projects`).", Exit.target)
  const title = opts.title ?? (prompt.split("\n")[0]!.slice(0, 80) || "Thread")
  const ticket = await client.post<Ticket>("/tickets", {
    projectId: project.id,
    title,
    tracked: false,
    ...(opts.harness && { harness: opts.harness })
  })
  const session = await client.post<AgentSession>(`/tickets/${ticket.id}/sessions`, {
    prompt,
    ...(opts.harness && { harness: opts.harness })
  })
  if (!opts.wait) {
    out.write(out.json ? JSON.stringify({ ticket, session }) : `${session.id}  ${ticket.identifier}  ${title}`)
    return Exit.ok
  }
  return waitForTurn(client, out, session.id, 0, opts.timeoutSec)
}

export const send = async (client: Client, out: Output, query: string, text: string, opts: { wait?: boolean; timeoutSec?: number }) => {
  const session = await resolveSession(client, query)
  const fresh = await client.get<AgentSession>(`/sessions/${session.id}`)
  await client.post(`/sessions/${session.id}/prompt`, { text })
  if (!opts.wait) {
    out.write(out.json ? JSON.stringify({ sessionId: session.id, sent: true }) : `sent to ${session.id}`)
    return Exit.ok
  }
  return waitForTurn(client, out, session.id, fresh.lastEventId, opts.timeoutSec)
}

/** Wait for the current turn: returns at once when the agent is not working. */
export const wait = async (client: Client, out: Output, query: string, opts: { timeoutSec?: number }) => {
  const session = await resolveSession(client, query)
  const fresh = await client.get<AgentSession>(`/sessions/${session.id}`)
  if (!WORKING.includes(fresh.state)) return report(out, fresh, exitFor(fresh.state))
  return waitForTurn(client, out, session.id, fresh.lastEventId, opts.timeoutSec)
}

const exitFor = (state: AgentSession["state"]) =>
  state === "waiting_for_approval" ? Exit.blocked : state === "failed" || state === "interrupted" ? Exit.failed : Exit.ok

const report = (out: Output, session: AgentSession, code: number, text?: string) => {
  if (out.json) out.write(JSON.stringify({ session, exitCode: code, ...(text !== undefined && { text }) }))
  else {
    if (text) out.write(text)
    out.write(`[${session.state}${session.statusDetail ? `: ${session.statusDetail}` : ""}]`)
  }
  return code
}

/**
 * Follow the session's events after `afterId` until the turn ends (0, or 1 on error),
 * the agent blocks on an approval (5) or the process exits. Prints the turn's final text.
 */
export const waitForTurn = async (client: Client, out: Output, sessionId: string, afterId: number, timeoutSec?: number) => {
  const controller = new AbortController()
  const timer = timeoutSec ? setTimeout(() => controller.abort(), timeoutSec * 1000) : undefined
  const texts: Array<string> = []
  let code: number | undefined
  try {
    for await (const m of client.stream(`/sessions/${sessionId}/events?after=${afterId}`, controller.signal)) {
      if (m.event !== "agent") continue
      const { event } = JSON.parse(m.data) as StoredAgentEvent
      if (event.type === "message.completed") texts.push(event.text)
      else if (event.type === "approval.requested") code = Exit.blocked
      else if (event.type === "turn.completed")
        code = event.status === "error" ? Exit.failed : event.status === "interrupted" ? Exit.interrupted : Exit.ok
      else if (event.type === "session.exited") code = Exit.ok
      // A failed start (setup script, missing harness) ends the session without a turn.
      else if (event.type === "session.error" && (await client.get<AgentSession>(`/sessions/${sessionId}`)).state === "failed") code = Exit.failed
      if (code !== undefined) break
    }
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
  }
  const session = await client.get<AgentSession>(`/sessions/${sessionId}`)
  if (code === undefined) {
    if (timeoutSec) throw new CliError(`Timed out after ${timeoutSec}s; the agent is still ${session.state}.`, Exit.failed)
    code = exitFor(session.state)
  }
  if (code === Exit.ok && (session.state === "failed" || session.state === "interrupted")) code = Exit.failed
  return report(out, session, code, texts.join("\n\n") || undefined)
}

export const control = async (client: Client, out: Output, query: string, action: "interrupt" | "stop") => {
  const session = await resolveSession(client, query)
  await client.post(`/sessions/${session.id}/${action}`)
  out.write(out.json ? JSON.stringify({ sessionId: session.id, action }) : `${action} sent to ${session.id}`)
  return Exit.ok
}

export const approvals = async (client: Client, out: Output) => {
  const list = await client.get<ReadonlyArray<Approval>>("/approvals?pending=1")
  if (out.json) out.write(JSON.stringify(list))
  else for (const a of list) out.write(`${pad(a.id, 36)}  ${pad(a.kind, 13)}  ${pad(a.sessionId ?? "", 36)}  ${a.title}`)
  return Exit.ok
}

export const decide = async (
  client: Client,
  out: Output,
  query: string,
  decision: "allow" | "deny",
  note: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  opts: { session?: boolean } = {}
) => {
  refuseInsideAgent(env)
  const pending = await client.get<ReadonlyArray<Approval>>("/approvals?pending=1")
  const approval = resolveOne("pending approval", query, pending)
  if (approval.kind === "question" && decision === "allow") {
    throw new CliError(`${approval.id} is a question: answer it with \`agentdesk answer ${approval.id.slice(0, 8)} <answer>\``, Exit.usage)
  }
  const scope = opts.session && decision === "allow" ? "session" : undefined
  const result = await client.post(`/approvals/${approval.id}/decision`, { decision, ...(note && { note }), ...(scope && { scope }) })
  out.write(
    out.json
      ? JSON.stringify(result ?? { approvalId: approval.id, decision, ...(scope && { scope }) })
      : `${decision === "allow" ? (scope ? "Allowed for the session" : "Allowed") : "Denied"}: ${approval.title}`
  )
  return Exit.ok
}

// An agent must never approve or answer for the user, for itself or a sibling.
const refuseInsideAgent = (env: NodeJS.ProcessEnv) => {
  if (env.AGENTDESK_SESSION_ID) {
    throw new CliError("Approval decisions are refused inside an AgentDesk agent session; ask the user.", Exit.failed)
  }
}

/** Answer an agent's question(s): one answer per question, in order. An answer matching an option uses that option. */
export const answer = async (client: Client, out: Output, query: string, given: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env) => {
  refuseInsideAgent(env)
  const pending = await client.get<ReadonlyArray<Approval>>("/approvals?pending=1")
  const approval = resolveOne("pending question", query, pending.filter((a) => a.kind === "question"))
  const questions = ((approval.details ?? {}) as { questions?: ReadonlyArray<{ id: string; question: string; options: ReadonlyArray<{ label: string }> }> }).questions ?? []
  if (given.length !== questions.length) {
    const list = questions.map((q, i) => `  ${i + 1}. ${q.question}${q.options.length ? ` [${q.options.map((o) => o.label).join(" | ")}]` : ""}`).join("\n")
    throw new CliError(`Give ${questions.length} answer(s), one per question:\n${list}`, Exit.usage)
  }
  const answers = Object.fromEntries(
    questions.map((q, i) => {
      const text = given[i]!.trim()
      const option = q.options.find((o) => o.label.toLowerCase() === text.toLowerCase())
      return [q.id, [option?.label ?? text]]
    })
  )
  await client.post(`/approvals/${approval.id}/decision`, { decision: "allow", answers })
  out.write(out.json ? JSON.stringify({ approvalId: approval.id, answers }) : `Answered: ${approval.title}`)
  return Exit.ok
}

/**
 * Newline-delimited JSON, one object per line: change notices, or one session's agent
 * events (from now on, or from the start with `replay`). Runs until interrupted.
 */
export const events = async (client: Client, out: Output, opts: { session?: string; replay?: boolean }, signal: AbortSignal) => {
  if (opts.session) {
    const session = await resolveSession(client, opts.session)
    const after = opts.replay ? 0 : (await client.get<AgentSession>(`/sessions/${session.id}`)).lastEventId
    for await (const m of client.stream(`/sessions/${session.id}/events?after=${after}`, signal)) {
      if (m.event === "agent") out.write(m.data)
    }
  } else {
    for await (const m of client.stream("/events", signal)) {
      if (m.event === "notice") out.write(JSON.stringify(JSON.parse(m.data) as ChangeNotice))
    }
  }
  return signal.aborted ? Exit.interrupted : Exit.ok
}
