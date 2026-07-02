import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
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

  getEventLogPath(): string {
    return this.paths.daemonEventLogPath()
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

    rotateLogIfLarge(status.logPath)

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

    // If the pid file write fails (EACCES, ENOSPC, etc.), tear down the
    // detached daemon we just spawned — otherwise the next `start()` would
    // see no pid file and spawn a second daemon that races for the gateway
    // port. unref()/keepAwake() are after the write because both depend on
    // the pid being persisted first.
    try {
      this.writePidExclusive(status.pidPath, child.pid)
    } catch (error) {
      try {
        process.kill(child.pid, "SIGTERM")
      } catch {
        // best-effort: child may already have exited
      }
      throw error
    }
    child.unref()

    this.maybeKeepAwake(child.pid)

    return { pid: child.pid, logPath: status.logPath }
  }

  /**
   * `wx` refuses to overwrite an existing pid file, shrinking the
   * check-then-spawn race: when two `leuco start` calls run concurrently the
   * loser of this write gets an EEXIST instead of silently clobbering the
   * winner's pid. A stale file left by a crashed daemon (status() said "not
   * running") is removed once, then the exclusive write is retried.
   */
  private writePidExclusive(pidPath: string, pid: number): void {
    try {
      writeFileSync(pidPath, `${pid}\n`, { mode: 0o600, flag: "wx" })
      return
    } catch (error) {
      if (!isErrnoCode(error, "EEXIST")) throw error
    }

    const holder = readPid(pidPath)
    if (holder !== null && holder !== pid && pidIsAlive(holder)) {
      throw new Error(`leuco already running (pid ${holder})`)
    }

    removePidFile(pidPath)
    writeFileSync(pidPath, `${pid}\n`, { mode: 0o600, flag: "wx" })
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

  /**
   * Send SIGTERM and wait for the child to actually exit before removing the
   * pid file. Removing the pid file too early causes back-to-back
   * `stop()` → `start()` flows (move-to, rename, merge-into, relocate) to
   * spawn a second daemon that fights for the gateway port. After a 10s grace
   * period SIGKILL is sent; the pid file is removed in either case.
   */
  stop(): DaemonStopResult {
    const status = this.status()
    if (status.pid === null) return { stopped: false, pid: null }

    const pid = status.pid
    let stopped = false
    try {
      process.kill(pid, "SIGTERM")
      stopped = true
    } catch {
      // already gone
    }

    if (stopped) {
      waitForExit(pid, SHUTDOWN_GRACE_MS)
      if (pidIsAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // already gone
        }
        waitForExit(pid, SIGKILL_GRACE_MS)
      }
    }

    removePidFile(status.pidPath)
    return { stopped, pid }
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
    // 0 / negative pids address process groups — a corrupted pid file must
    // never make stop() SIGTERM the caller's whole group or every process.
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isNodeErrno(error) && error.code === "EPERM") return true
    return false
  }
}

const isNodeErrno = (error: unknown): error is NodeJS.ErrnoException => {
  return error instanceof Error && "code" in error
}

const isErrnoCode = (error: unknown, code: string): boolean => {
  return isNodeErrno(error) && error.code === code
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024

/** Cap the append-only daemon log: past 10MB the old log moves to `<log>.1`
 * (replacing the previous backup) so a long-lived daemon cannot eat the disk. */
const rotateLogIfLarge = (logPath: string): void => {
  try {
    const stat = statSync(logPath)
    if (stat.size < LOG_ROTATE_BYTES) return
    renameSync(logPath, `${logPath}.1`)
  } catch {
    // missing log (fresh install) or unrotatable — appending still works
  }
}

const removePidFile = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // idempotent
  }
}

const SHUTDOWN_GRACE_MS = 10_000
const SIGKILL_GRACE_MS = 2_000
const POLL_INTERVAL_MS = 50

const waitForExit = (pid: number, timeoutMs: number): void => {
  const deadline = Date.now() + timeoutMs
  while (pidIsAlive(pid)) {
    if (Date.now() >= deadline) return
    Bun.sleepSync(POLL_INTERVAL_MS)
  }
}
