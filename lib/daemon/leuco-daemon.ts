import { spawn } from "node:child_process"
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs"
import type { DaemonPidLease } from "@/daemon/daemon-pid-lease"
import type { DaemonProcessPort } from "@/daemon/daemon-process-port"
import { parseLegacyDaemonPid } from "@/daemon/legacy-pid-lease/parse-legacy-daemon-pid"
import { toVerifiedLegacyDaemonPidLease } from "@/daemon/legacy-pid-lease/to-verified-legacy-daemon-pid-lease"
import { NodeDaemonProcess } from "@/daemon/node-daemon-process"
import { atomicWriteText } from "@/fs/atomic-write-text"
import { withFileLock } from "@/fs/with-file-lock"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"
import { LeucoPaths } from "@/paths/leuco-paths"

export type LeucoDaemonProps = {
  paths?: LeucoPaths
  pidLockTimeoutMs?: number
  processPort?: DaemonProcessPort
}

export type LeucoDaemonStartProps = {
  binPath: string
  cwd?: string
  env: NodeJS.ProcessEnv
}

export type DaemonStatus = {
  pid: number | null
  isRunning: boolean
  identityVerified?: boolean
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

type DaemonLeaseStatus = {
  isRunning: boolean
  identityVerified: boolean
}

/**
 * Machine-wide background daemon manager. State lives at
 * `~/.leuco/daemon/{pid,log}`; the daemon supervises every registered
 * project runtimes in one process, so there is exactly one daemon per
 * machine regardless of how many projects are configured.
 */
export class LeucoDaemon {
  private readonly paths: LeucoPaths
  private readonly pidLockTimeoutMs: number | undefined
  private readonly processPort: DaemonProcessPort

  constructor(props: LeucoDaemonProps = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    this.pidLockTimeoutMs = props.pidLockTimeoutMs
    this.processPort = props.processPort ?? new NodeDaemonProcess()
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

  /**
   * Register a foreground `leuco run` process in the same pid file used by
   * `leuco start`. launchd invokes `run` directly, so without this lease the
   * CLI reports it as stopped and can start a second daemon on the same port.
   */
  claimCurrentProcess(): void {
    this.withPidLeaseLock(() => {
      const pidPath = this.paths.daemonPidPath()
      const currentLease = readPidLease(pidPath)
      if (
        currentLease !== null &&
        currentLease.pid !== process.pid &&
        this.isLeaseRunning(currentLease)
      ) {
        throw new Error(`leuco already running (pid ${currentLease.pid})`)
      }
      const currentIdentity = this.requireProcessIdentity(process.pid)

      const stateDir = this.paths.daemonDir()
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      chmodSync(stateDir, 0o700)
      const logPath = this.paths.daemonLogPath()
      if (existsSync(logPath)) {
        // launchd opens StandardOutPath before this process starts, so a
        // rename would leave it writing to the old inode. Copy + truncate
        // bounds that already-open stream without disconnecting diagnostics.
        rotateOpenLogIfLarge(logPath)
        chmodSync(logPath, 0o600)
      }

      const lease = toVerifiedLease(process.pid, currentIdentity)
      writePidLease(pidPath, lease)
      if (!isSameLease(readPidLease(pidPath), lease)) {
        throw new Error("failed to verify daemon pid lease ownership")
      }
    })
  }

  /**
   * Release only this process's lease. The ownership check prevents an old
   * process exiting late from deleting the pid file of its replacement.
   */
  releaseCurrentProcess(): boolean {
    const pidPath = this.paths.daemonPidPath()
    const processIdentity = this.processPort.getIdentity(process.pid)
    if (processIdentity === null) return false

    const lease = toVerifiedLease(process.pid, processIdentity)
    return this.withPidLeaseLock(() => removePidFileIfOwned(pidPath, lease))
  }

  status(): DaemonStatus {
    const pidPath = this.paths.daemonPidPath()
    const logPath = this.paths.daemonLogPath()
    const lease = readPidLease(pidPath)
    const leaseStatus = lease === null ? null : this.inspectLease(lease)

    return {
      pid: lease?.pid ?? null,
      isRunning: leaseStatus?.isRunning ?? false,
      identityVerified: leaseStatus?.identityVerified ?? false,
      pidPath,
      logPath,
    }
  }

  start(props: LeucoDaemonStartProps): DaemonStartResult {
    const result = this.withPidLeaseLock(() => this.startLocked(props))
    this.maybeKeepAwake(result.pid)
    return result
  }

  private startLocked(props: LeucoDaemonStartProps): DaemonStartResult {
    const status = this.status()
    if (status.isRunning) {
      throw new Error(`leuco already running (pid ${status.pid})`)
    }

    const stateDir = this.paths.daemonDir()
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    chmodSync(stateDir, 0o700)

    rotateLogIfLarge(status.logPath)
    const logFd = openSync(status.logPath, "a", 0o600)
    chmodSync(status.logPath, 0o600)
    const child = (() => {
      try {
        return spawn(process.execPath, [props.binPath, "run"], {
          cwd: props.cwd ?? this.paths.getHome(),
          env: props.env,
          stdio: ["ignore", logFd, logFd],
          detached: true,
        })
      } finally {
        closeSync(logFd)
      }
    })()

    if (typeof child.pid !== "number") {
      throw new Error("failed to spawn daemon (no pid)")
    }

    // If the pid file write fails (EACCES, ENOSPC, etc.), tear down the
    // detached daemon we just spawned — otherwise the next `start()` would
    // see no pid file and spawn a second daemon that races for the gateway
    // port. unref()/keepAwake() are after the write because both depend on
    // the pid being persisted first.
    try {
      const processIdentity = this.waitForProcessIdentity(child.pid)
      if (processIdentity === null) {
        throw new Error("failed to identify spawned daemon process")
      }
      const lease = toVerifiedLease(child.pid, processIdentity)
      writePidLease(status.pidPath, lease)
      if (!isSameLease(readPidLease(status.pidPath), lease)) {
        throw new Error("failed to verify spawned daemon pid lease ownership")
      }
    } catch (error) {
      this.processPort.sendSignal(child.pid, "SIGTERM")
      throw error
    }
    child.unref()

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

  /**
   * Send SIGTERM and wait for the child to actually exit before removing the
   * pid file. Removing the pid file too early causes back-to-back
   * `stop()` → `start()` flows (move-to, rename, merge-into, relocate) to
   * spawn a second daemon that fights for the gateway port. After a 15s grace
   * period SIGKILL is sent; the pid file is removed in either case.
   */
  stop(): DaemonStopResult {
    const pidPath = this.paths.daemonPidPath()
    const lease = readPidLease(pidPath)
    if (lease === null) return { stopped: false, pid: null }

    const signalLease = this.withPidLeaseLock(() => this.toSignalSafeLease(pidPath, lease))
    const signalSent =
      signalLease !== null &&
      this.withPidLeaseLock(() => this.sendSignalIfOwned(pidPath, signalLease, "SIGTERM"))

    if (signalLease !== null && signalSent) {
      this.waitForExit(signalLease, SHUTDOWN_GRACE_MS)
      if (this.isLeaseVerified(signalLease)) {
        this.withPidLeaseLock(() => this.sendSignalIfOwned(pidPath, signalLease, "SIGKILL"))
        this.waitForExit(signalLease, SIGKILL_GRACE_MS)
      }
    }

    const observedLease = signalLease ?? lease
    const isRunning = this.isLeaseRunning(observedLease)
    const stopped = signalSent && !isRunning
    // launchd may already have started a replacement after the old process
    // exited. Never let the old stop operation erase the replacement's lease.
    if (!isRunning) {
      this.withPidLeaseLock(() => removePidFileIfOwned(pidPath, observedLease))
    }
    return { stopped, pid: lease.pid }
  }

  /** Send SIGHUP so a running daemon re-reads config and reconciles projects. */
  reload(): { signalled: boolean; pid: number | null } {
    const pidPath = this.paths.daemonPidPath()
    const lease = readPidLease(pidPath)
    if (lease === null) return { signalled: false, pid: null }

    const signalLease = this.withPidLeaseLock(() => this.toSignalSafeLease(pidPath, lease))
    const signalled =
      signalLease !== null &&
      this.withPidLeaseLock(() => this.sendSignalIfOwned(pidPath, signalLease, "SIGHUP"))
    return { signalled, pid: lease.pid }
  }

  private withPidLeaseLock<T>(fn: () => T): T {
    return withFileLock(
      {
        lockPath: `${this.paths.daemonPidPath()}.lock`,
        timeoutMs: this.pidLockTimeoutMs,
      },
      fn,
    )
  }

  private isLeaseRunning(lease: DaemonPidLease): boolean {
    return this.inspectLease(lease).isRunning
  }

  private inspectLease(lease: DaemonPidLease): DaemonLeaseStatus {
    if (lease.processIdentity === null) {
      return { isRunning: this.processPort.isAlive(lease.pid), identityVerified: false }
    }

    const processIdentity = this.processPort.getIdentity(lease.pid)
    if (processIdentity === null) {
      return { isRunning: this.processPort.isAlive(lease.pid), identityVerified: false }
    }

    const identityVerified = processIdentity === lease.processIdentity
    return { isRunning: identityVerified, identityVerified }
  }

  private isLeaseVerified(lease: DaemonPidLease): boolean {
    if (lease.processIdentity === null) return false
    return this.processPort.getIdentity(lease.pid) === lease.processIdentity
  }

  private toSignalSafeLease(pidPath: string, lease: DaemonPidLease): DaemonPidLease | null {
    if (lease.processIdentity !== null) return lease
    if (!isSameLease(readPidLease(pidPath), lease)) return null

    const processIdentity = this.processPort.getIdentity(lease.pid)
    const migratedLease = toVerifiedLegacyDaemonPidLease({
      pid: lease.pid,
      processCommand: this.processPort.getCommand(lease.pid),
      processIdentity,
    })
    if (migratedLease === null) return null
    if (this.processPort.getIdentity(lease.pid) !== processIdentity) return null

    writePidLease(pidPath, migratedLease)
    return isSameLease(readPidLease(pidPath), migratedLease) ? migratedLease : null
  }

  private sendSignalIfOwned(
    pidPath: string,
    lease: DaemonPidLease,
    signal: NodeJS.Signals,
  ): boolean {
    if (!isSameLease(readPidLease(pidPath), lease)) return false
    if (!this.isLeaseVerified(lease)) return false
    return this.processPort.sendSignal(lease.pid, signal)
  }

  private waitForExit(lease: DaemonPidLease, timeoutMs: number): void {
    const deadline = this.processPort.now() + timeoutMs
    while (this.isLeaseVerified(lease)) {
      if (this.processPort.now() >= deadline) return
      this.processPort.sleep(POLL_INTERVAL_MS)
    }
  }

  private waitForProcessIdentity(pid: number): string | null {
    const deadline = this.processPort.now() + PROCESS_IDENTITY_TIMEOUT_MS
    while (true) {
      const identity = this.processPort.getIdentity(pid)
      if (identity !== null) return identity
      if (this.processPort.now() >= deadline) return null
      this.processPort.sleep(PROCESS_IDENTITY_POLL_MS)
    }
  }

  private requireProcessIdentity(pid: number): string {
    const identity = this.processPort.getIdentity(pid)
    if (identity !== null) return identity
    throw new Error(`failed to identify daemon process ${pid}`)
  }
}

const readPidLease = (path: string): DaemonPidLease | null => {
  try {
    const text = readFileSync(path, "utf8").trim()
    const legacyPid = parseLegacyDaemonPid(text)
    if (legacyPid !== null) return { version: 1, pid: legacyPid, processIdentity: null }

    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null) return null
    if (!("version" in value) || value.version !== 1) return null
    if (!("pid" in value) || typeof value.pid !== "number") return null
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null
    if (!("processIdentity" in value) || typeof value.processIdentity !== "string") return null
    if (value.processIdentity.length < 1 || value.processIdentity.length > 256) return null

    return {
      version: 1,
      pid: value.pid,
      processIdentity: value.processIdentity,
    }
  } catch {
    return null
  }
}

const toVerifiedLease = (pid: number, processIdentity: string): DaemonPidLease => {
  return { version: 1, pid, processIdentity }
}

const writePidLease = (path: string, lease: DaemonPidLease): void => {
  atomicWriteText({
    path,
    text: `${JSON.stringify(lease)}\n`,
    mode: 0o600,
  })
  chmodSync(path, 0o600)
}

const isSameLease = (left: DaemonPidLease | null, right: DaemonPidLease | null): boolean => {
  if (left === null || right === null) return left === right
  return left.pid === right.pid && left.processIdentity === right.processIdentity
}

const removePidFile = (path: string): void => {
  try {
    unlinkSync(path)
  } catch {
    // idempotent
  }
}

const removePidFileIfOwned = (path: string, lease: DaemonPidLease): boolean => {
  if (!isSameLease(readPidLease(path), lease)) return false
  removePidFile(path)
  return true
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024

const rotateLogIfLarge = (logPath: string): void => {
  try {
    if (statSync(logPath).size < LOG_ROTATE_BYTES) return
    const rotatedPath = `${logPath}.1`
    renameSync(logPath, rotatedPath)
    chmodSync(rotatedPath, 0o600)
  } catch {
    // A missing or temporarily unrotatable log must not block daemon startup.
  }
}

const rotateOpenLogIfLarge = (logPath: string): void => {
  try {
    if (statSync(logPath).size < LOG_ROTATE_BYTES) return
    const rotatedPath = `${logPath}.1`
    copyFileSync(logPath, rotatedPath)
    chmodSync(rotatedPath, 0o600)
    truncateSync(logPath, 0)
  } catch {
    // Log maintenance must not prevent launchd's child from claiming its pid.
  }
}

// `leuco run` has a 12s internal shutdown deadline. Keep the outer daemon
// manager's SIGTERM window longer so normal cleanup wins before SIGKILL.
const SHUTDOWN_GRACE_MS = 15_000
const SIGKILL_GRACE_MS = 2_000
const POLL_INTERVAL_MS = 50
const PROCESS_IDENTITY_TIMEOUT_MS = 1_000
const PROCESS_IDENTITY_POLL_MS = 10
