import type { AgentSession, Approval } from "@agentdesk/contracts"
import { describe, expect, it, vi } from "vitest"
import { notificationCount } from "../src/renderer/lib/agent-state"
import { createNotificationBadge } from "../src/main/notification-badge"

const sessions = [{ id: "waiting", state: "waiting_for_approval", lastEventId: 3 }, { id: "done", state: "idle", lastEventId: 5 }, { id: "running", state: "running", lastEventId: 9 }] as Array<AgentSession>
const approvals = [{ sessionId: "waiting" }] as Array<Approval>

describe("native notification badge", () => {
  it("deduplicates approvals and unread session updates, and clears when handled", () => {
    expect(notificationCount(sessions, approvals, {})).toBe(2)
    expect(notificationCount(sessions, approvals, { done: 5 })).toBe(1)
    expect(notificationCount(sessions, [], { waiting: 3, done: 5 })).toBe(0)
    expect(notificationCount(sessions, [], { waiting: 3, done: 5, running: -1 })).toBe(1)
  })
  it("updates from the renderer and polls independently after the window closes", async () => {
    const setBadge = vi.fn()
    const get = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("approvals") ? approvals : sessions)))
    const badge = createNotificationBadge({ connection: () => ({ url: "http://localhost", token: "test" }), setBadge, fetch: get as typeof fetch })
    badge.update(0, { waiting: 3, done: 5 })
    await badge.refresh()
    expect(setBadge.mock.calls.map((c) => c[0])).toEqual([0, 1])
    badge.update(2, {})
    await badge.refresh()
    expect(setBadge).toHaveBeenLastCalledWith(2)
    get.mockRejectedValueOnce(new Error("Daemon unavailable"))
    await badge.refresh()
    expect(setBadge).toHaveBeenLastCalledWith(2)
    badge.update(-5, {})
    badge.update(10, { bad: "invalid" })
    expect(setBadge).toHaveBeenLastCalledWith(2)
    badge.stop()
    badge.update(0, {})
    await badge.refresh()
    expect(setBadge).toHaveBeenLastCalledWith(2)
  })
})
