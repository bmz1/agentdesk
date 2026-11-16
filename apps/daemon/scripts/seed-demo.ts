/**
 * Seeds a demo project (a throwaway git repo) and a handful of local tickets
 * against a running daemon. Usage: pnpm --filter @agentdesk/daemon seed:demo
 */
import { execSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { connectionFilePath, defaultDataDir } from "../src/config"

const conn = JSON.parse(readFileSync(connectionFilePath(defaultDataDir()), "utf8")) as { url: string; token: string }
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(conn.url + path, {
    method,
    headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.status === 204 ? undefined : res.json()
}

const repo = join(defaultDataDir(), "demo-repo")
mkdirSync(repo, { recursive: true })
try {
  execSync("git rev-parse HEAD", { cwd: repo, stdio: "ignore" })
} catch {
  execSync("git init -q -b main", { cwd: repo })
  writeFileSync(join(repo, "README.md"), "# Demo service\n\nA tiny repo for trying AgentDesk.\n")
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2))
  execSync("git add . && git -c user.name=demo -c user.email=demo@localhost commit -qm init", { cwd: repo })
}

const main = async () => {
  const projects = (await call("GET", "/projects")) as Array<{ id: string; key: string }>
  const project =
    projects.find((p) => p.key === "DEMO") ??
    (await call("POST", "/projects", {
      name: "Demo service",
      key: "DEMO",
      repoPath: repo,
      defaultHarness: "mock",
      permissionMode: "ask",
      testCommand: "npm test"
    }))
  const tickets = [
    { title: "Add rate limiting to the public API", priority: "high", status: "todo", description: "Use a token bucket per API key." },
    { title: "Document the release process", priority: "low", status: "todo", description: "Write RELEASING.md" },
    { title: "Fix flaky checkout integration test", priority: "urgent", status: "in_progress", labels: ["flaky", "ci"] },
    { title: "Migrate config loader to schema validation", priority: "medium", status: "in_review" },
    { title: "Upgrade database driver", priority: "medium", status: "blocked", description: "Blocked on infra freeze." },
    { title: "Initial project scaffold", priority: "none", status: "done" }
  ]
  for (const t of tickets) await call("POST", "/tickets", { projectId: project.id, ...t })
  console.log(`Seeded project ${project.id} with ${tickets.length} tickets`)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
