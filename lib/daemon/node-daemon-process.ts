import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFileSync, readlinkSync } from "node:fs"
import { DaemonProcessPort } from "@/daemon/daemon-process-port"
import { getNodeProcessCommand } from "@/daemon/legacy-pid-lease/get-node-process-command"

export class NodeDaemonProcess extends DaemonProcessPort {
  private readonly bootIdentity: string

  constructor() {
    super()
    this.bootIdentity = getBootIdentity()
    Object.freeze(this)
  }

  getCommand(pid: number): string | null {
    return getNodeProcessCommand(pid)
  }

  getIdentity(pid: number): string | null {
    const fingerprint =
      process.platform === "linux" ? getLinuxFingerprint(pid) : getPsFingerprint(pid)
    if (fingerprint === null) return null

    return createHash("sha256").update(`${this.bootIdentity}\0${fingerprint}`).digest("hex")
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return isNodeErrno(error) && error.code === "EPERM"
    }
  }

  sendSignal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }

  now(): number {
    return Date.now()
  }

  sleep(durationMs: number): void {
    if (typeof Bun !== "undefined") {
      Bun.sleepSync(durationMs)
      return
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs)
  }
}

const getBootIdentity = (): string => {
  if (process.platform === "linux") {
    try {
      return `linux:${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}`
    } catch {
      return "linux:unknown-boot"
    }
  }

  if (process.platform === "darwin") {
    const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
    })
    const value = result.status === 0 ? result.stdout.trim() : ""
    if (value.length > 0) return `darwin:${value}`
  }

  return `${process.platform}:unknown-boot`
}

const getLinuxFingerprint = (pid: number): string | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const commandEnd = stat.lastIndexOf(") ")
    if (commandEnd < 0) return null

    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/)
    const startTicks = fields[19]
    if (startTicks === undefined || !/^\d+$/.test(startTicks)) return null

    return `${startTicks}\0${readlinkSync(`/proc/${pid}/exe`)}`
  } catch {
    return null
  }
}

const getPsFingerprint = (pid: number): string | null => {
  const result = spawnSync(
    "/bin/ps",
    ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
    {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    },
  )
  if (result.status !== 0) return null

  const value = result.stdout.trim()
  return value.length > 0 ? value : null
}

const isNodeErrno = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error
