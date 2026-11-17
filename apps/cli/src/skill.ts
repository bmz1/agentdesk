import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The installed skill only points back at the CLI, so its instructions always match the
 * installed AgentDesk version and never need reinstalling after an upgrade.
 */
export const SKILL_FILE = `---
name: agentdesk
description: Delegate coding work to AgentDesk agents and check on them from the shell - start threads in a project, send follow-ups, wait for a turn to finish, and list sessions that need the user. Use when the user asks to hand off, parallelize or check on AgentDesk work.
---

Run \`agentdesk skill\` and follow the instructions it prints. They match the installed AgentDesk version.
`

export const INSTRUCTIONS = `# Using AgentDesk from an agent

AgentDesk runs coding agents (Claude Code, Codex, OpenCode) in their own git worktrees,
supervised by a local daemon. The \`agentdesk\` CLI talks to that daemon.

Always pass --json when you parse output. Every --json command prints one JSON value
(\`events\` prints one JSON object per line).

## Commands

  agentdesk projects                          projects (id, key, repo path)
  agentdesk new "<prompt>" [--project KEY]    start a thread in its own worktree (project: the one containing $PWD)
        [--title T] [--harness claude|codex|opencode] [--wait] [--timeout S]
  agentdesk ls [--active] [--attention]       sessions with state and a one-line status
  agentdesk show <session>                    one session, with its latest message
  agentdesk send <session> "<text>" [--wait]  follow-up prompt (resumes ended conversations)
  agentdesk wait <session> [--timeout S]      block until the current turn ends; prints its final text
  agentdesk interrupt|stop <session>
  agentdesk events [--session S] [--replay]   stream changes as NDJSON until interrupted
  agentdesk approvals                         pending approvals (read only for agents)

<session> is a session id, a unique id prefix (4+ characters), or a ticket identifier such
as AD-12 (its current session).

## Exit codes

  0 ok · 1 failed · 2 bad command line · 3 target missing or ambiguous (nothing changed)
  4 daemon unreachable · 5 the agent is waiting for an approval · 130 interrupted

## Rules

- Never approve or deny tool calls. \`agentdesk approve\`/\`deny\` refuse to run inside an
  AgentDesk session; when \`wait\` exits 5, tell the user an approval is waiting.
- Prefer \`--wait\` over polling \`ls\`.
- Give each delegated task a self-contained prompt: the other agent cannot see this conversation.
`

export interface SetupOptions {
  /** Install into `<cwd>/.claude/skills` instead of the user's `~/.claude/skills`. */
  readonly project?: boolean
  /** Install into `<dir>/agentdesk/SKILL.md` (for other agents' skill folders). */
  readonly dir?: string
  readonly cwd?: string
  readonly home?: string
}

export const skillPath = (opts: SetupOptions = {}) => {
  const root = opts.dir ?? join(opts.project ? (opts.cwd ?? process.cwd()) : (opts.home ?? homedir()), ".claude", "skills")
  return join(root, "agentdesk", "SKILL.md")
}

export const installSkill = (opts: SetupOptions = {}) => {
  const path = skillPath(opts)
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (current === SKILL_FILE) return { path, changed: false }
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, SKILL_FILE)
  return { path, changed: true }
}

export const skillStatus = (opts: SetupOptions = {}) => {
  const path = skillPath(opts)
  if (!existsSync(path)) return { path, installed: false, current: false }
  return { path, installed: true, current: readFileSync(path, "utf8") === SKILL_FILE }
}
