import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { makeRepo, startTestDaemon, waitFor } from "../../daemon/test/helpers"
import { CliError, Exit, makeClient } from "../src/client"
import { resolveOne } from "../src/commands"
import { run } from "../src/main"
import { SKILL_FILE } from "../src/skill"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const cli = (url: string, env: NodeJS.ProcessEnv = {}, cwd = process.cwd()) => {
  return async (...argv: Array<string>) => {
    const stdout: Array<string> = []
    const stderr: Array<string> = []
    const code = await run(argv, {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
      env,
      cwd,
      signal: new AbortController().signal,
      client: () => makeClient({ url, token: "test-token" })
    })
    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n"), json: () => JSON.parse(stdout.join("\n")) }
  }
}

describe("target resolution", () => {
  const items = [{ id: "abcd1234", key: "AD" }, { id: "abcd5678", key: "WEB" }, { id: "ffff0000", key: "OPS" }]
  it("prefers exact ids, then keys, then unique prefixes of 4+ characters", () => {
    expect(resolveOne("project", "ffff0000", items, (i) => i.key).id).toBe("ffff0000")
    expect(resolveOne("project", "web", items, (i) => i.key).id).toBe("abcd5678")
    expect(resolveOne("project", "ffff", items).id).toBe("ffff0000")
  })
  it("fails with exit 3 and lists the matches when ambiguous or missing", () => {
    const err = (() => {
      try {
        resolveOne("project", "abcd", items)
      } catch (e) {
        return e as CliError
      }
    })()
    expect(err?.code).toBe(Exit.target)
    expect(err?.details).toEqual({ matches: ["abcd1234", "abcd5678"] })
    expect(() => resolveOne("project", "ff", items)).toThrow(/No project/)
  })
})

describe("agentdesk CLI", () => {
  it("prints usage with exit 2 for bad command lines", async () => {
    const run = cli("http://127.0.0.1:9")
    expect((await run()).code).toBe(Exit.usage)
    expect((await run("frobnicate")).code).toBe(Exit.usage)
    expect((await run("show")).code).toBe(Exit.usage)
    expect((await run("ls", "--bogus")).code).toBe(Exit.usage)
  })

  it("exits 4 when no daemon answers", async () => {
    const r = await cli("http://127.0.0.1:9")("ls", "--json")
    expect(r.code).toBe(Exit.unreachable)
    expect(r.json()).toMatchObject({ exitCode: Exit.unreachable })
  })

  it("starts a thread, waits on approvals (exit 5) and turns, and sends follow-ups", async () => {
    const { daemon, api } = await startTestDaemon()
    cleanups.push(daemon.stop)
    const repo = makeRepo()
    const project = await api.post("/projects", { name: "Cli App", repoPath: repo, defaultHarness: "mock" })
    const run = cli(daemon.url, {}, repo)

    // The project comes from the working directory; the mock agent asks before writing.
    const started = await run("new", "write notes", "--wait", "--json")
    expect(started.code).toBe(Exit.blocked)
    const { session } = started.json()
    expect(session.state).toBe("waiting_for_approval")
    expect(session.statusDetail).toMatch(/^Needs approval/)

    const listed = await run("ls", "--attention", "--json")
    expect(listed.json().map((s: { id: string }) => s.id)).toContain(session.id)

    // Agents cannot decide approvals, even with the CLI at hand.
    const pending = (await run("approvals", "--json")).json()
    expect(pending).toHaveLength(1)
    const refused = await cli(daemon.url, { AGENTDESK_SESSION_ID: session.id })("approve", pending[0].id)
    expect(refused.code).toBe(Exit.failed)
    expect(refused.stderr).toMatch(/refused inside an AgentDesk agent session/)

    expect((await run("approve", pending[0].id.slice(0, 8))).code).toBe(Exit.ok)
    const done = await run("wait", session.id, "--json")
    expect(done.code).toBe(Exit.ok)
    expect(done.json().session.state).toBe("idle")

    // Ticket identifiers address the ticket's current session.
    const ticket = (await api.get(`/tickets?projectId=${project.id}`))[0]
    const followUp = await run("send", ticket.identifier, "answer only [noop]", "--wait")
    expect(followUp.code).toBe(Exit.ok)
    expect(followUp.stdout).toMatch(/\[idle: Turn finished\]/)

    expect((await run("show", "AD-404")).code).toBe(Exit.target)
    expect((await run("stop", session.id)).code).toBe(Exit.ok)
    await waitFor(async () => (await api.get(`/sessions/${session.id}`)).state === "closed" || undefined)
  })

  it("installs a skill that defers to the CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentdesk-cli-home-"))
    const run = cli("http://127.0.0.1:9", { HOME: home })
    expect((await run("skill", "status")).stdout).toMatch(/^not installed/)
    const setup = await run("skill", "setup", "--json")
    expect(setup.json()).toEqual({ path: join(home, ".claude", "skills", "agentdesk", "SKILL.md"), changed: true })
    expect(readFileSync(setup.json().path, "utf8")).toBe(SKILL_FILE)
    expect((await run("skill", "setup", "--json")).json().changed).toBe(false)
    expect((await run("skill")).stdout).toMatch(/Never approve or deny/)
  })
})
