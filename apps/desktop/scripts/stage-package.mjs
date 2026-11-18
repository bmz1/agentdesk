// Stages the packaged app in build/app: the electron-vite output, the bundled daemon,
// and the runtime dependencies left external: the daemon's native better-sqlite3 and
// the main process's electron-updater. electron-builder packages
// this directory (directories.app) and rebuilds better-sqlite3 for Electron's ABI and
// the target arch, so the workspace's pnpm node_modules never reach the installer.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoDir = resolve(desktopDir, "../..")
const daemonDir = join(repoDir, "apps/daemon")
const stageDir = join(desktopDir, "build/app")

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))
const desktopPkg = readJson(join(desktopDir, "package.json"))
const daemonPkg = readJson(join(daemonDir, "package.json"))

for (const required of [join(desktopDir, "out/main/index.js"), join(daemonDir, "dist/main.js")]) {
  if (!existsSync(required)) throw new Error(`Missing ${required}; run the daemon and desktop builds first.`)
}

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })
cpSync(join(desktopDir, "out"), join(stageDir, "out"), { recursive: true })
cpSync(join(daemonDir, "dist"), join(stageDir, "daemon"), { recursive: true })

const dependencies = {
  "better-sqlite3": daemonPkg.dependencies["better-sqlite3"],
  "electron-updater": desktopPkg.dependencies["electron-updater"]
}
writeFileSync(
  join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: "agentdesk",
      productName: desktopPkg.productName,
      version: desktopPkg.version,
      description: "Local control plane for coding agents",
      author: { name: "AgentDesk" },
      homepage: "https://github.com/bmz1/agentdesk",
      license: "UNLICENSED",
      private: true,
      type: "module",
      main: desktopPkg.main,
      dependencies
    },
    null,
    2
  )}\n`
)

// Plain npm keeps a flat, self-contained node_modules (no pnpm symlinks into the store).
// The "package" script hides pnpm's npm_config_user_agent/npm_execpath from electron-builder,
// which would otherwise collect modules from the pnpm workspace instead of this directory.
// Scripts are skipped: electron-builder compiles the native module for Electron afterwards.
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: stageDir,
  stdio: "inherit",
  shell: process.platform === "win32"
})

console.log(`Staged ${desktopPkg.productName} ${desktopPkg.version} in ${stageDir}`)
