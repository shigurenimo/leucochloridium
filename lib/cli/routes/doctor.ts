import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { join } from "node:path"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const help = `leuco doctor / diagnose daemon, projects, and channels

usage / leuco doctor [--fix]

output / valid YAML with nested diagnostics for each subsystem

checks:
  - daemon: pid file, process liveness, log file
  - codex: binary on PATH, version
  - settings: file exists, parseable, permissions
  - projects: path exists, codex home, auth symlink, config.toml
  - channels: token presence, socket mode readiness
  - zombies: orphaned codex app-server processes

options:
  --fix / kill orphaned codex app-server processes

exit codes:
  0 / all checks passed
  1 / one or more issues found`

type Check = {
  status: "ok" | "warn" | "error"
  message: string
}

type ZombieProcess = {
  pid: number
  command: string
}

type ZombieReport = {
  check: Check
  processes: ZombieProcess[]
  killed: number[]
}

type ProjectReport = {
  name: string
  path: string
  enabled: boolean
  checks: Record<string, Check>
  channels: Array<{
    name: string
    type: string
    enabled: boolean
    checks: Record<string, Check>
  }>
}

type DoctorReport = {
  status: "ok" | "warn" | "error"
  daemon: Record<string, Check>
  codex: Record<string, Check>
  settings: Record<string, Check>
  projects: ProjectReport[]
  zombies: ZombieReport
}

const ok = (message: string): Check => ({ status: "ok", message })
const warn = (message: string): Check => ({ status: "warn", message })
const error = (message: string): Check => ({ status: "error", message })

const checkDaemon = (pidPath: string, logPath: string): Record<string, Check> => {
  const checks: Record<string, Check> = {}

  if (!existsSync(pidPath)) {
    checks.pid = warn("no pid file — daemon is not running")
    checks.process = error("daemon not running")
    return checks
  }

  const pidText = readFileSync(pidPath, "utf8").trim()
  const pid = Number.parseInt(pidText, 10)

  if (!Number.isFinite(pid)) {
    checks.pid = error(`pid file contains invalid value: ${pidText}`)
    checks.process = error("daemon not running")
    return checks
  }

  checks.pid = ok(`pid ${pid}`)

  try {
    process.kill(pid, 0)
    checks.process = ok(`process ${pid} alive`)
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      checks.process = ok(`process ${pid} alive (permission restricted)`)
    } else {
      checks.process = error(`process ${pid} not found — stale pid file`)
    }
  }

  if (existsSync(logPath)) {
    const logStat = statSync(logPath)
    const ageSec = (Date.now() - logStat.mtimeMs) / 1000
    checks.log = ageSec < 600 ? ok(`log active (${Math.round(ageSec)}s ago)`) : warn(`log stale (${Math.round(ageSec)}s since last write)`)
  } else {
    checks.log = warn("log file missing")
  }

  return checks
}

const checkCodex = (): Record<string, Check> => {
  const checks: Record<string, Check> = {}
  const codexBin = process.env.LEUCO_CODEX_BIN ?? "codex"

  try {
    const result = Bun.spawnSync([codexBin, "--version"], {
      timeout: 5000,
      stderr: "pipe",
      stdout: "pipe",
    })
    const stdout = result.stdout.toString().trim()
    const stderr = result.stderr.toString().trim()
    const version = stdout || stderr

    if (result.exitCode === 0 && version.length > 0) {
      checks.binary = ok(`${codexBin} → ${version}`)
    } else {
      checks.binary = error(`${codexBin} exited ${result.exitCode}: ${version || "(no output)"}`)
    }
  } catch {
    checks.binary = error(`${codexBin} not found on PATH`)
  }

  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex")
  const authPath = join(codexHome, "auth.json")

  if (existsSync(authPath)) {
    checks.auth = ok(`${authPath} exists`)
  } else {
    checks.auth = error(`${authPath} missing — run \`codex login\``)
  }

  return checks
}

const checkSettings = (settingsPath: string): Record<string, Check> => {
  const checks: Record<string, Check> = {}

  if (!existsSync(settingsPath)) {
    checks.file = error(`${settingsPath} does not exist`)
    return checks
  }

  checks.file = ok(settingsPath)

  try {
    const stat = statSync(settingsPath)
    const mode = stat.mode & 0o777

    if (mode === 0o600) {
      checks.permissions = ok("0600")
    } else {
      checks.permissions = warn(`${mode.toString(8)} — expected 0600`)
    }
  } catch (err) {
    checks.permissions = error(`stat failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const content = readFileSync(settingsPath, "utf8")
    JSON.parse(content)
    checks.parse = ok("valid JSON")
  } catch (err) {
    checks.parse = error(`parse failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return checks
}

const checkProject = (paths: LeucoPaths, project: {
  id: string
  name: string
  path: string
  enabled: boolean
  channels: Array<{ name: string; type: string; enabled: boolean; botToken?: string; appToken?: string }>
}): ProjectReport => {
  const checks: Record<string, Check> = {}

  if (existsSync(project.path)) {
    checks.path = ok(project.path)
  } else {
    checks.path = error(`${project.path} does not exist`)
  }

  const codexHome = paths.projectHome(project.id)

  if (existsSync(codexHome)) {
    checks.codexHome = ok(codexHome)
  } else {
    checks.codexHome = error(`${codexHome} missing`)
  }

  const authLink = join(codexHome, "auth.json")

  if (existsSync(authLink)) {
    try {
      const isLink = lstatSync(authLink).isSymbolicLink()

      if (isLink) {
        const target = readlinkSync(authLink)
        const targetExists = existsSync(target)
        checks.authSymlink = targetExists ? ok(`→ ${target}`) : error(`→ ${target} (dangling)`)
      } else {
        checks.authSymlink = warn("auth.json is a regular file, not a symlink")
      }
    } catch (err) {
      checks.authSymlink = error(`stat failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else {
    checks.authSymlink = error(`${authLink} missing`)
  }

  const configToml = join(codexHome, "config.toml")
  checks.configToml = existsSync(configToml) ? ok(configToml) : error(`${configToml} missing`)

  const channelReports = project.channels.map((ch) => {
    const channelChecks: Record<string, Check> = {}

    if (ch.type === "slack") {
      const hasBotToken = typeof ch.botToken === "string" && ch.botToken.length > 0
      const hasAppToken = typeof ch.appToken === "string" && ch.appToken.length > 0

      channelChecks.botToken = hasBotToken
        ? ok(`set (${ch.botToken!.slice(0, 8)}…)`)
        : error("missing — set with `leuco projects <p> channels <c> set-tokens`")

      channelChecks.appToken = hasAppToken
        ? ok(`set (${ch.appToken!.slice(0, 8)}…)`)
        : error("missing — socket mode requires an app-level token")

      if (hasBotToken && !ch.botToken!.startsWith("xoxb-")) {
        channelChecks.botTokenFormat = warn("expected xoxb- prefix")
      }

      if (hasAppToken && !ch.appToken!.startsWith("xapp-")) {
        channelChecks.appTokenFormat = warn("expected xapp- prefix")
      }
    }

    if (ch.type === "schedule") {
      channelChecks.type = ok("schedule channel — no tokens required")
    }

    return {
      name: ch.name,
      type: ch.type,
      enabled: ch.enabled,
      checks: channelChecks,
    }
  })

  return {
    name: project.name,
    path: project.path,
    enabled: project.enabled,
    checks,
    channels: channelReports,
  }
}

/**
 * Find orphaned `codex app-server` processes. A codex app-server is orphaned
 * when the leuco daemon is not running but the child process is still alive.
 * Also catches codex processes whose parent pid is 1 (reparented to init/launchd).
 */
const findZombieCodexProcesses = (daemonPid: number | null, isDaemonRunning: boolean): ZombieProcess[] => {
  try {
    const result = Bun.spawnSync(["pgrep", "-f", "codex app-server"], {
      timeout: 5000,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = result.stdout.toString().trim()

    if (stdout.length === 0) return []

    const pids = stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid))

    if (isDaemonRunning && daemonPid !== null) {
      return pids
        .filter((pid) => !isChildOf(pid, daemonPid))
        .map((pid) => ({ pid, command: getProcessCommand(pid) }))
    }

    return pids.map((pid) => ({ pid, command: getProcessCommand(pid) }))
  } catch {
    return []
  }
}

const isChildOf = (pid: number, parentPid: number): boolean => {
  try {
    const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
      timeout: 3000,
      stdout: "pipe",
      stderr: "pipe",
    })
    const ppid = Number.parseInt(result.stdout.toString().trim(), 10)
    return ppid === parentPid
  } catch {
    return false
  }
}

const getProcessCommand = (pid: number): string => {
  try {
    const result = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
      timeout: 3000,
      stdout: "pipe",
      stderr: "pipe",
    })
    return result.stdout.toString().trim()
  } catch {
    return "(unknown)"
  }
}

const killZombies = (zombies: ZombieProcess[]): number[] => {
  const killed: number[] = []

  for (const zombie of zombies) {
    try {
      process.kill(zombie.pid, "SIGTERM")
      killed.push(zombie.pid)
    } catch {
      // already gone
    }
  }

  return killed
}

const checkZombies = (daemonPid: number | null, isDaemonRunning: boolean, fix: boolean): ZombieReport => {
  const zombies = findZombieCodexProcesses(daemonPid, isDaemonRunning)

  if (zombies.length === 0) {
    return { check: ok("no orphaned codex processes"), processes: [], killed: [] }
  }

  const killed = fix ? killZombies(zombies) : []
  const pidList = zombies.map((z) => z.pid).join(", ")

  if (fix && killed.length > 0) {
    return {
      check: warn(`killed ${killed.length} orphaned codex process(es): ${killed.join(", ")}`),
      processes: zombies,
      killed,
    }
  }

  return {
    check: error(`${zombies.length} orphaned codex process(es): ${pidList} — run \`leuco doctor --fix\` to kill`),
    processes: zombies,
    killed: [],
  }
}

const worstStatus = (statuses: Array<"ok" | "warn" | "error">): "ok" | "warn" | "error" => {
  if (statuses.includes("error")) return "error"
  if (statuses.includes("warn")) return "warn"
  return "ok"
}

const allChecks = (report: DoctorReport): Array<"ok" | "warn" | "error"> => {
  const statuses: Array<"ok" | "warn" | "error"> = []

  for (const check of Object.values(report.daemon)) statuses.push(check.status)
  for (const check of Object.values(report.codex)) statuses.push(check.status)
  for (const check of Object.values(report.settings)) statuses.push(check.status)
  statuses.push(report.zombies.check.status)

  for (const project of report.projects) {
    for (const check of Object.values(project.checks)) statuses.push(check.status)
    for (const channel of project.channels) {
      for (const check of Object.values(channel.checks)) statuses.push(check.status)
    }
  }

  return statuses
}

export const doctorHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const fix = flagBool(body.flags.fix)
  const paths = new LeucoPaths()
  const store = new LeucoProjectStore({ paths })

  let projects: ReturnType<LeucoProjectStore["list"]> = []

  try {
    projects = store.list()
  } catch {
    // settings parse failed — handled by checkSettings
  }

  const daemonChecks = checkDaemon(paths.daemonPidPath(), paths.daemonLogPath())
  const isDaemonRunning = daemonChecks.process?.status === "ok"
  const daemonPidMatch = daemonChecks.pid?.message.match(/pid (\d+)/)
  const daemonPid = daemonPidMatch ? Number.parseInt(daemonPidMatch[1]!, 10) : null

  const report: DoctorReport = {
    status: "ok",
    daemon: daemonChecks,
    codex: checkCodex(),
    settings: checkSettings(paths.settingsPath()),
    projects: projects.map((p) =>
      checkProject(paths, {
        id: p.id,
        name: p.name,
        path: p.path,
        enabled: p.enabled,
        channels: p.channels.map((ch) => ({
          name: ch.name,
          type: ch.type,
          enabled: ch.enabled,
          ...("botToken" in ch ? { botToken: ch.botToken } : {}),
          ...("appToken" in ch ? { appToken: ch.appToken } : {}),
        })),
      }),
    ),
    zombies: checkZombies(daemonPid, isDaemonRunning, fix),
  }

  report.status = worstStatus(allChecks(report))

  const hasError = report.status === "error"
  return c.text(renderYaml(report), hasError ? 503 : 200)
})
