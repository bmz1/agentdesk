import type { AgentSession } from "@agentdesk/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { isSessionUnread, nextAttention, READ_BASELINE_KEY } from "../src/renderer/lib/agent-state"
import { formatChord, matchesChord, SHORTCUTS } from "../src/renderer/lib/keymap"
import { applyNotice, qk, queryClient } from "../src/renderer/lib/queries"

const session = (id: string, patch: Partial<AgentSession> = {}): AgentSession => ({
  id,
  ticketId: "t",
  runId: null,
  stepRunId: null,
  harness: "mock",
  providerSessionId: null,
  state: "idle",
  cwd: "/",
  pid: null,
  lastEventId: 10,
  statusDetail: null,
  preview: null,
  createdAt: "2026-11-17T12:00:00Z",
  updatedAt: "2026-11-17T12:00:00Z",
  ...patch
})

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  key: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt
})

describe("keymap", () => {
  it("matches chords exactly, with mod as ⌘ on macOS and Ctrl elsewhere", () => {
    expect(matchesChord(key("k", { meta: true }), "mod+k", true)).toBe(true)
    expect(matchesChord(key("k", { ctrl: true }), "mod+k", true)).toBe(false)
    expect(matchesChord(key("k", { ctrl: true }), "mod+k", false)).toBe(true)
    // Shift reports an upper-case key; extra modifiers never match.
    expect(matchesChord(key("A", { meta: true, shift: true }), "mod+shift+a", true)).toBe(true)
    expect(matchesChord(key("a", { meta: true }), "mod+shift+a", true)).toBe(false)
    expect(matchesChord(key("k", { meta: true, alt: true }), "mod+k", true)).toBe(false)
    expect(matchesChord(key("c"), "c", true)).toBe(true)
    expect(matchesChord(key(".", { meta: true }), "mod+.", true)).toBe(true)
  })

  it("formats hints per platform", () => {
    expect(formatChord("mod+shift+a", true)).toBe("⌘⇧A")
    expect(formatChord("mod+shift+a", false)).toBe("Ctrl+Shift+A")
    expect(formatChord("mod+,", true)).toBe("⌘,")
  })

  it("binds every chord once", () => {
    const chords = Object.values(SHORTCUTS).map((s) => s.keys)
    expect(new Set(chords).size).toBe(chords.length)
  })
})

describe("unread state", () => {
  it("treats sessions that finished before the read baseline as read until they change", () => {
    const baseline = Date.parse("2026-11-17T13:00:00Z")
    const old = session("old")
    expect(isSessionUnread(old, {})).toBe(true)
    expect(isSessionUnread(old, { [READ_BASELINE_KEY]: baseline })).toBe(false)
    expect(isSessionUnread({ ...old, updatedAt: "2026-11-17T14:00:00Z" }, { [READ_BASELINE_KEY]: baseline })).toBe(true)
    expect(isSessionUnread(old, { [READ_BASELINE_KEY]: baseline, old: -1 })).toBe(true)
  })

  it("walks approvals first, then unread sessions, and cycles", () => {
    const sessions = [
      session("read", { lastEventId: 5 }),
      session("unread-old", { updatedAt: "2026-11-17T10:00:00Z" }),
      session("unread-new", { updatedAt: "2026-11-17T11:00:00Z" }),
      session("blocked", { state: "waiting_for_approval", updatedAt: "2026-11-17T09:00:00Z" }),
      session("working", { state: "running" })
    ]
    const seen = { read: 5 }
    expect(nextAttention(sessions, seen)?.id).toBe("blocked")
    expect(nextAttention(sessions, seen, "blocked")?.id).toBe("unread-new")
    expect(nextAttention(sessions, seen, "unread-new")?.id).toBe("unread-old")
    expect(nextAttention(sessions, seen, "unread-old")?.id).toBe("blocked")
    expect(nextAttention([sessions[0]!], seen)).toBeUndefined()
  })
})

describe("pushed session notices", () => {
  afterEach(() => queryClient.clear())

  it("updates cached lists in place, keeps lists newest first and drops ended sessions from the active list", () => {
    const a = session("a", { state: "running" })
    queryClient.setQueryData(qk.sessions(false), [a])
    queryClient.setQueryData(qk.sessions(true), [a])
    queryClient.setQueryData(qk.ticketSessions("t"), [a])

    const b = session("b", { state: "starting", lastEventId: 1 })
    applyNotice({ topic: "sessions", sessionId: "b", ticketId: "t", session: b })
    expect(queryClient.getQueryData<Array<AgentSession>>(qk.sessions(true))?.map((s) => s.id)).toEqual(["b", "a"])

    const blocked = { ...a, state: "waiting_for_approval" as const, lastEventId: 11, statusDetail: "Needs approval: Bash: ls" }
    applyNotice({ topic: "sessions", sessionId: "a", ticketId: "t", session: blocked })
    expect(queryClient.getQueryData<Array<AgentSession>>(qk.ticketSessions("t"))?.find((s) => s.id === "a")?.statusDetail).toBe(
      "Needs approval: Bash: ls"
    )
    expect(queryClient.getQueryData<AgentSession>(qk.session("a"))?.state).toBe("waiting_for_approval")

    // A late, older snapshot does not roll the session back.
    applyNotice({ topic: "sessions", sessionId: "a", ticketId: "t", session: a })
    expect(queryClient.getQueryData<Array<AgentSession>>(qk.sessions(false))?.find((s) => s.id === "a")?.state).toBe(
      "waiting_for_approval"
    )

    applyNotice({ topic: "sessions", sessionId: "a", ticketId: "t", session: { ...blocked, state: "closed", lastEventId: 12 } })
    expect(queryClient.getQueryData<Array<AgentSession>>(qk.sessions(true))?.map((s) => s.id)).toEqual(["b"])
    expect(queryClient.getQueryData<Array<AgentSession>>(qk.sessions(false))?.map((s) => s.id)).toEqual(["b", "a"])
    // Pushed notices update in place: nothing was marked stale for a refetch.
    expect(queryClient.getQueryState(qk.sessions(false))?.isInvalidated).toBe(false)
  })
})

describe("ticket notices", () => {
  afterEach(() => queryClient.clear())

  it("leave a ticket's session, approval and activity queries alone", () => {
    for (const key of [qk.ticket("t"), qk.ticketDiff("t"), qk.ticketSessions("t"), qk.ticketActivity("t"), qk.ticketApprovals("t"), qk.tickets({})]) {
      queryClient.setQueryData(key, [])
    }
    applyNotice({ topic: "tickets", ticketId: "t" })
    const stale = (key: ReadonlyArray<unknown>) => queryClient.getQueryState(key)?.isInvalidated
    expect([qk.ticket("t"), qk.ticketDiff("t"), qk.tickets({})].map(stale)).toEqual([true, true, true])
    expect([qk.ticketSessions("t"), qk.ticketActivity("t"), qk.ticketApprovals("t")].map(stale)).toEqual([false, false, false])
  })
})
