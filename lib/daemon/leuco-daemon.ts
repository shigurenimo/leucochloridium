import { spawn } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"
import { LeucoPaths } from "@/paths/leuco-paths"

type Props = {
  paths?: LeucoPaths
}

type StartProps = {
  binPath: string
  cwd?: string
  env: NodeJS.ProcessEnv
}

export type DaemonStatus = {
  pid: number | null
  isRunning: boolean
  pidPath: string
  logPath: string
}

export type DaemonStartResult = {
  pid: number
  logPath: string
}

export type DaemonStopResult = {
  stopped: boolean
  pid: number | null
}

/**
 * Machine-wide background daemon manager. State lives at
 * `~/.leuco/daemon/{pid,log}`; the daemon supervises every registered
 * project's tenants in one process, so there is exactly one daemon per
 * machine regardless of how many projects are configured.
 */
export class LeucoDaemon {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  getPidPath(): string {
    return this.paths.daemonPidPath()
  }

  getLogPath(): string {
    return this.paths.daemonLogPath()
  }

  status(): DaemonStatus {
    const pidPath = this.paths.daemonPidPath()
    const logPath = this.paths.daemonLogPath()
    const pid = readPid(pidPath)

    return {
      pid,
      isRunning: pid !== null && pidIsAlive(pid),
      pidPath,
      logPath,
    }
  }

  start(props: StartProps): DaemonStartResult {
    const status = this.status()
    if (status.isRunning) {
      throw new Error(`leuco already running (pid ${status.pid})`)
    }

    const stateDir = this.paths.daemonDir()
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

    const logFd = openSync(status.logPath, "a")

    const child = spawn(process.execPath, [props.binPath, "run"], {
      cwd: props.cwd ?? this.paths.getHome(),
      env: props.env,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    })

    if (typeof child.pid !== "number") {
      throw new Error("failed to spawn daemon (no pid)")
    }

    writeFileSync(status.pidPath, `${child.pid}\n`)
    child.unref()

    this.maybeKeepAwake(child.pid)

    return { pid: child.pid, logPath: status.logPath }
  }

  /**
   * macOS only: spawn `caffeinate -is -w <pid>` so the system stays awake while
   * the daemon runs, then exits as soon as the daemon does. The daemon's own
   * pid is unchanged — caffeinate is a sidecar, not a wrapper. Disabled when
   * `~/.leuco/settings.json#keepAwake` is false. Failure is non-fatal.
   *
   * `-i` blocks idle sleep and `-s` blocks system sleep (including lid-close
   * clamshell sleep) while on AC power. On battery `-s` is ignored by macOS.
   */
  private maybeKeepAwake(daemonPid: number): void {
    if (process.platform !== "darwin") return

    const settings = new LeucoGlobalSettingsStore({ paths: this.paths }).load()
    if (settings instanceof Error) return
    if (!settings.keepAwake) return

    try {
      const caf = spawn("caffeinate", ["-is", "-w", String(daemonPid)], {
        stdio: "ignore",
        detached: true,
      })
      caf.on("error", () => {})
      caf.unref()
    } catch {
      // caffeinate not on PATH; fall through silently
    }
  }

  stop(): DaemonStopResult {
    const status = this.status()
    if (status.pid === null) return { stopped: false, pid: null }

    let stopped = false
    try {
      process.kill(status.pid, "SIGTERM")
      stopped = true
    } catch {
      // already gone
    }
    removePidFile(status.pidPath)
    return { stopped, pid: status.pid }
  }

  /** Send SIGHUP so a running daemon re-reads config and reconciles tenants. */
  reload(): { signalled: boolean; pid: number | null } {
    const status = this.status()
    if (!status.isRunning || status.pid === null) {
      return { signalled: false, pid: status.pid }
    }
    try {
      process.kill(status.pid, "SIGHUP")
      return { signalled: true, pid: status.pid }
    } catch {
      return { signalled: false, pid: status.pid }
    }
  }

  clearStalePid(): void {
    removePidFile(this.paths.daemonPidPath())
  }
}

const readPid = (path: string): number | null => {
  try {
    const text = readFileSync(path, "utf8").trim()
    const pid = Number.parseInt(text, 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const removePidFile = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // idempotent
  }
}
