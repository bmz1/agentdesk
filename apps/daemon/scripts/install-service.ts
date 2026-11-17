/**
 * Installs the AgentDesk daemon as a per-user login service so agent work
 * survives the desktop app quitting:
 *   - macOS: ~/Library/LaunchAgents/dev.agentdesk.daemon.plist (launchd)
 *   - Linux: ~/.config/systemd/user/agentdesk-daemon.service (systemd --user)
 * Usage: pnpm --filter @agentdesk/daemon build && pnpm --filter @agentdesk/daemon install-service [--uninstall]
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultDataDir } from "../src/config"

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, "../dist/main.js")
const uninstall = process.argv.includes("--uninstall")
const dataDir = defaultDataDir()
const logDir = join(dataDir, "logs")
mkdirSync(logDir, { recursive: true })

if (!uninstall && !existsSync(entry)) {
  console.error(`Build the daemon first: ${entry} not found (pnpm --filter @agentdesk/daemon build)`)
  process.exit(1)
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

if (process.platform === "darwin") {
  const label = "dev.agentdesk.daemon"
  const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`)
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid!()}`, plist], { stdio: "ignore" })
  } catch {
    /* not loaded */
  }
  if (uninstall) {
    rmSync(plist, { force: true })
    console.log(`Removed ${plist}`)
    process.exit(0)
  }
  mkdirSync(dirname(plist), { recursive: true })
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTDESK_PERSISTENT</key><string>1</string>
    <key>AGENTDESK_HOME</key><string>${xml(dataDir)}</string>
    <key>PATH</key><string>${xml(process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(join(logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`
  )
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid!()}`, plist])
  console.log(`Installed and started launchd agent ${label} (${plist})`)
} else if (process.platform === "linux") {
  const unit = join(homedir(), ".config/systemd/user/agentdesk-daemon.service")
  if (uninstall) {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", "agentdesk-daemon"], { stdio: "inherit" })
    } catch {
      /* ignore */
    }
    rmSync(unit, { force: true })
    console.log(`Removed ${unit}`)
    process.exit(0)
  }
  mkdirSync(dirname(unit), { recursive: true })
  writeFileSync(
    unit,
    `[Unit]
Description=AgentDesk daemon

[Service]
ExecStart=${process.execPath} ${entry}
Environment=AGENTDESK_PERSISTENT=1
Environment=AGENTDESK_HOME=${dataDir}
Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
`
  )
  execFileSync("systemctl", ["--user", "daemon-reload"])
  execFileSync("systemctl", ["--user", "enable", "--now", "agentdesk-daemon"], { stdio: "inherit" })
  console.log(`Installed systemd user service (${unit})`)
} else {
  console.error("Automatic service install supports macOS (launchd) and Linux (systemd --user).")
  process.exit(1)
}
