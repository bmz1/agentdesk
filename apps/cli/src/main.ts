import { parseArgs } from "node:util"
import { CliError, type Client, discover, Exit, makeClient } from "./client"
import * as commands from "./commands"
import { INSTRUCTIONS, installSkill, SKILL_FILE, skillStatus } from "./skill"

const USAGE = `usage: agentdesk <command> [options]

  status                       daemon info
  projects                     list projects
  new <prompt>                 start a thread   [--project KEY] [--title T] [--harness H] [--wait] [--timeout S]
  ls                           list sessions    [--active] [--attention]
  show <session>               one session
  send <session> <text>        follow-up prompt [--wait] [--timeout S]
  wait <session>               wait for the current turn [--timeout S]
  interrupt <session>          interrupt the current turn
  stop <session>               stop the agent process
  approvals                    pending approvals
  approve <approval>           allow           [--note N] [--for-session]
  deny <approval>              deny            [--note N]
  answer <question> <answer>…  answer an agent's question(s), one answer per question
  events                       NDJSON change stream [--session S] [--replay]
  skill                        print instructions for agents
  skill setup                  install the Claude Code skill [--local] [--dir D]
  skill status | show

global: --json  machine-readable output

exit codes: 0 ok, 1 failed, 2 usage, 3 target missing/ambiguous, 4 daemon unreachable,
            5 agent waiting for approval, 130 interrupted`

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  active: { type: "boolean" },
  attention: { type: "boolean" },
  project: { type: "string", short: "p" },
  title: { type: "string" },
  harness: { type: "string" },
  wait: { type: "boolean", short: "w" },
  timeout: { type: "string" },
  note: { type: "string" },
  session: { type: "string", short: "s" },
  replay: { type: "boolean" },
  dir: { type: "string" },
  local: { type: "boolean" },
  "for-session": { type: "boolean" }
} as const

export interface Io {
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly signal: AbortSignal
  /** Overridable for tests. */
  readonly client?: () => Client
}

const usage = (message: string) => new CliError(`${message}\n\n${USAGE}`, Exit.usage)

export const run = async (argv: ReadonlyArray<string>, io: Io): Promise<number> => {
  let parsed
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (e) {
    io.stderr(`${(e as Error).message}\n\n${USAGE}`)
    return Exit.usage
  }
  const { values: o, positionals } = parsed
  const [command, ...rest] = positionals
  if (o.help || !command) {
    io.stdout(USAGE)
    return o.help ? Exit.ok : Exit.usage
  }
  const out: commands.Output = { json: !!o.json, write: io.stdout }
  const timeoutSec = o.timeout !== undefined ? Number(o.timeout) : undefined
  const client = () => (io.client ?? (() => makeClient(discover(io.env))))()
  const arg = (name: string) => {
    const value = rest[0]
    if (!value) throw usage(`${command}: missing <${name}>`)
    return value
  }
  const text = (name: string, from = 0) => {
    const value = rest.slice(from).join(" ").trim()
    if (!value) throw usage(`${command}: missing <${name}>`)
    return value
  }

  try {
    if (timeoutSec !== undefined && !(timeoutSec > 0)) throw usage("--timeout must be a positive number of seconds")
    switch (command) {
      case "status":
        return await commands.status(client(), out)
      case "projects":
        return await commands.projects(client(), out)
      case "ls":
        return await commands.ls(client(), out, { active: o.active, attention: o.attention })
      case "show":
        return await commands.show(client(), out, arg("session"))
      case "new":
        return await commands.newThread(
          client(),
          out,
          text("prompt"),
          { project: o.project, title: o.title, harness: o.harness, wait: o.wait, timeoutSec },
          io.cwd
        )
      case "send":
        return await commands.send(client(), out, arg("session"), text("text", 1), { wait: o.wait, timeoutSec })
      case "wait":
        return await commands.wait(client(), out, arg("session"), { timeoutSec })
      case "interrupt":
      case "stop":
        return await commands.control(client(), out, arg("session"), command)
      case "approvals":
        return await commands.approvals(client(), out)
      case "approve":
      case "deny":
        return await commands.decide(client(), out, arg("approval"), command === "approve" ? "allow" : "deny", o.note, io.env, { session: o["for-session"] })
      case "answer": {
        if (rest.length < 2) throw usage("answer: missing <question> <answer>")
        return await commands.answer(client(), out, rest[0]!, rest.slice(1), io.env)
      }
      case "events":
        return await commands.events(client(), out, { session: o.session, replay: o.replay }, io.signal)
      case "skill": {
        const sub = rest[0]
        const where = { project: o.local, dir: o.dir, cwd: io.cwd, home: io.env.HOME }
        if (!sub) {
          io.stdout(INSTRUCTIONS)
          return Exit.ok
        }
        if (sub === "show") {
          io.stdout(SKILL_FILE)
          return Exit.ok
        }
        if (sub === "status") {
          const s = skillStatus(where)
          io.stdout(out.json ? JSON.stringify(s) : `${s.installed ? (s.current ? "installed" : "outdated") : "not installed"}: ${s.path}`)
          return Exit.ok
        }
        if (sub === "setup") {
          const r = installSkill(where)
          io.stdout(out.json ? JSON.stringify(r) : `${r.changed ? "Installed" : "Already up to date"}: ${r.path}`)
          return Exit.ok
        }
        throw usage(`skill: unknown subcommand "${sub}"`)
      }
      default:
        throw usage(`unknown command "${command}"`)
    }
  } catch (e) {
    if (e instanceof CliError) {
      if (out.json && e.code !== Exit.usage) io.stdout(JSON.stringify({ error: e.message, exitCode: e.code, ...(e.details !== undefined && { details: e.details }) }))
      else io.stderr(e.message)
      return e.code
    }
    io.stderr(`agentdesk: ${(e as Error).stack ?? String(e)}`)
    return Exit.failed
  }
}

const isEntry = () => {
  const entry = process.argv[1]
  return !!entry && /(?:^|[/\\])(?:main\.(?:ts|js)|agentdesk)$/.test(entry)
}

if (isEntry()) {
  const controller = new AbortController()
  process.once("SIGINT", () => controller.abort())
  process.once("SIGTERM", () => controller.abort())
  const code = await run(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(line + "\n"),
    stderr: (line) => process.stderr.write(line + "\n"),
    env: process.env,
    // `pnpm agentdesk …` runs in apps/cli; INIT_CWD is where the user typed it.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    signal: controller.signal
  })
  process.exit(controller.signal.aborted && code === Exit.ok ? Exit.interrupted : code)
}
