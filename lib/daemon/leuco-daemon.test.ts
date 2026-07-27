import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
import { MemoryDaemonProcess } from "@/daemon/memory-daemon-process"
import { LeucoPaths } from "@/paths/leuco-paths"

const leaseText = (pid: number, processIdentity: string): string => {
  return `${JSON.stringify({ version: 1, pid, processIdentity })}\n`
}

describe("LeucoDaemon", () => {
  let home = ""
  let paths: LeucoPaths

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-daemon-"))
    paths = new LeucoPaths({ home })
    mkdirSync(paths.daemonDir(), { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  it("recognizes a live legacy numeric lease without treating it as signal-safe", () => {
    writeFileSync(paths.daemonPidPath(), "12345\n")
    const processPort = new MemoryDaemonProcess({ liveLegacyPids: [12345] })

    const status = new LeucoDaemon({ paths, processPort }).status()

    expect(status).toMatchObject({
      pid: 12345,
      isRunning: true,
      identityVerified: false,
    })
  })

  it("treats a dead legacy numeric lease as stale", () => {
    writeFileSync(paths.daemonPidPath(), "12345\n")

    const status = new LeucoDaemon({
      paths,
      processPort: new MemoryDaemonProcess(),
    }).status()

    expect(status).toMatchObject({
      pid: 12345,
      isRunning: false,
      identityVerified: false,
    })
  })

  it("treats a reused pid with a different process identity as stale without signalling it", () => {
    writeFileSync(paths.daemonPidPath(), leaseText(12345, "old-process"))
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: 12345, identity: "unrelated-process" }],
    })
    const daemon = new LeucoDaemon({ paths, processPort })

    expect(daemon.status()).toMatchObject({ pid: 12345, isRunning: false })
    expect(daemon.stop()).toEqual({ stopped: false, pid: 12345 })
    expect(processPort.signals).toEqual([])
    expect(processPort.getIdentity(12345)).toBe("unrelated-process")
    expect(existsSync(paths.daemonPidPath())).toBe(false)
  })

  it("does not signal a live legacy lease", () => {
    writeFileSync(paths.daemonPidPath(), "12345\n")
    const processPort = new MemoryDaemonProcess({ liveLegacyPids: [12345] })
    const daemon = new LeucoDaemon({ paths, processPort })

    expect(daemon.stop()).toEqual({ stopped: false, pid: 12345 })
    expect(daemon.reload()).toEqual({ signalled: false, pid: 12345 })
    expect(processPort.signals).toEqual([])
    expect(readFileSync(paths.daemonPidPath(), "utf8")).toBe("12345\n")
  })

  it("hardens daemon state and log permissions on start", async () => {
    const childPath = join(home, "daemon-child.ts")
    writeFileSync(
      childPath,
      ['process.on("SIGTERM", () => process.exit(0))', "setInterval(() => undefined, 1_000)"].join(
        "\n",
      ),
    )
    chmodSync(paths.daemonDir(), 0o755)
    writeFileSync(paths.daemonLogPath(), "existing\n", { mode: 0o644 })
    const daemon = new LeucoDaemon({ paths })

    const started = daemon.start({ binPath: childPath, cwd: home, env: process.env })
    try {
      expect(statSync(paths.daemonDir()).mode & 0o777).toBe(0o700)
      expect(statSync(paths.daemonLogPath()).mode & 0o777).toBe(0o600)
      expect(statSync(paths.daemonPidPath()).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(paths.daemonPidPath(), "utf8"))).toMatchObject({
        version: 1,
        pid: started.pid,
      })
    } finally {
      try {
        process.kill(started.pid, "SIGTERM")
      } catch {
        // already exited
      }
      await vi.waitFor(
        () => {
          expect(() => process.kill(started.pid, 0)).toThrow()
        },
        { timeout: 2_000 },
      )
    }
  })

  it("claims, upgrades, and releases a foreground run lease", () => {
    const logPath = paths.daemonLogPath()
    writeFileSync(logPath, "secret")
    writeFileSync(paths.daemonPidPath(), `${process.pid}\n`)
    chmodSync(paths.daemonDir(), 0o755)
    chmodSync(logPath, 0o644)
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: process.pid, identity: "current-process" }],
    })
    const daemon = new LeucoDaemon({ paths, processPort })

    daemon.claimCurrentProcess()

    expect(readFileSync(paths.daemonPidPath(), "utf8")).toBe(
      leaseText(process.pid, "current-process"),
    )
    expect(statSync(paths.daemonDir()).mode & 0o777).toBe(0o700)
    expect(statSync(logPath).mode & 0o777).toBe(0o600)
    expect(statSync(paths.daemonPidPath()).mode & 0o777).toBe(0o600)
    expect(daemon.status()).toMatchObject({
      pid: process.pid,
      isRunning: true,
      identityVerified: true,
    })
    expect(daemon.releaseCurrentProcess()).toBe(true)
    expect(existsSync(paths.daemonPidPath())).toBe(false)
  })

  it("does not enter the pid lease critical section while another claimant holds it", () => {
    const lockPath = `${paths.daemonPidPath()}.lock`
    mkdirSync(lockPath)
    writeFileSync(
      join(lockPath, "owner.json"),
      `${JSON.stringify({ token: "other", pid: process.pid })}\n`,
    )
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: process.pid, identity: "current-process" }],
    })
    const daemon = new LeucoDaemon({ paths, pidLockTimeoutMs: 30, processPort })

    expect(() => daemon.claimCurrentProcess()).toThrow("file lock busy")
    expect(existsSync(paths.daemonPidPath())).toBe(false)
  })

  it("rotates an oversized launchd log without replacing its open inode", () => {
    const logPath = paths.daemonLogPath()
    writeFileSync(logPath, "old")
    truncateSync(logPath, 10 * 1024 * 1024 + 1)
    const inode = statSync(logPath).ino
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: process.pid, identity: "current-process" }],
    })
    const daemon = new LeucoDaemon({ paths, processPort })

    daemon.claimCurrentProcess()

    expect(statSync(logPath).ino).toBe(inode)
    expect(statSync(logPath).size).toBe(0)
    expect(statSync(`${logPath}.1`).size).toBe(10 * 1024 * 1024 + 1)
    expect(daemon.releaseCurrentProcess()).toBe(true)
  })

  it("rejects a lease already owned by another live legacy process", () => {
    writeFileSync(paths.daemonPidPath(), "12345\n")
    const processPort = new MemoryDaemonProcess({ liveLegacyPids: [12345] })

    expect(() => new LeucoDaemon({ paths, processPort }).claimCurrentProcess()).toThrow(
      "leuco already running (pid 12345)",
    )
    expect(readFileSync(paths.daemonPidPath(), "utf8")).toBe("12345\n")
  })

  it.each([
    "0",
    "-1",
    "123junk",
    "1.5",
    "9007199254740992",
    '{"version":1,"pid":123,"processIdentity":""}',
    '{"version":2,"pid":123,"processIdentity":"old"}',
  ])("rejects unsafe pid file contents %s", (value) => {
    writeFileSync(paths.daemonPidPath(), `${value}\n`)

    const status = new LeucoDaemon({
      paths,
      processPort: new MemoryDaemonProcess(),
    }).status()

    expect(status).toMatchObject({ pid: null, isRunning: false })
  })

  it("does not release a pid lease owned by a replacement process", () => {
    writeFileSync(paths.daemonPidPath(), leaseText(12345, "replacement"))
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: process.pid, identity: "current-process" }],
    })

    const released = new LeucoDaemon({ paths, processPort }).releaseCurrentProcess()

    expect(released).toBe(false)
    expect(readFileSync(paths.daemonPidPath(), "utf8")).toBe(leaseText(12345, "replacement"))
  })

  it("does not erase a launchd replacement lease after stopping the old process", () => {
    writeFileSync(paths.daemonPidPath(), leaseText(12345, "old-process"))
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: 12345, identity: "old-process" }],
      onSignal: (call, memory) => {
        if (call.signal !== "SIGTERM") return true
        memory.setIdentity(12345, null)
        memory.setIdentity(67890, "replacement")
        writeFileSync(paths.daemonPidPath(), leaseText(67890, "replacement"))
        return true
      },
    })

    const result = new LeucoDaemon({ paths, processPort }).stop()

    expect(result).toEqual({ stopped: true, pid: 12345 })
    expect(readFileSync(paths.daemonPidPath(), "utf8")).toBe(leaseText(67890, "replacement"))
  })

  it("keeps a verified lease when SIGTERM cannot stop the process", () => {
    writeFileSync(paths.daemonPidPath(), leaseText(12345, "daemon"))
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: 12345, identity: "daemon" }],
      onSignal: () => false,
    })

    const result = new LeucoDaemon({ paths, processPort }).stop()

    expect(result).toEqual({ stopped: false, pid: 12345 })
    expect(processPort.signals).toEqual([{ pid: 12345, signal: "SIGTERM" }])
    expect(readFileSync(paths.daemonPidPath(), "utf8")).toBe(leaseText(12345, "daemon"))
  })

  it("sends SIGKILL only while the same verified process still owns the lease", () => {
    writeFileSync(paths.daemonPidPath(), leaseText(12345, "daemon"))
    const processPort = new MemoryDaemonProcess({
      identities: [{ pid: 12345, identity: "daemon" }],
      onSignal: (call, memory) => {
        if (call.signal === "SIGKILL") memory.setIdentity(call.pid, null)
        return true
      },
    })

    const result = new LeucoDaemon({ paths, processPort }).stop()

    expect(result).toEqual({ stopped: true, pid: 12345 })
    expect(processPort.signals).toEqual([
      { pid: 12345, signal: "SIGTERM" },
      { pid: 12345, signal: "SIGKILL" },
    ])
    expect(processPort.sleeps).toHaveLength(300)
    expect(existsSync(paths.daemonPidPath())).toBe(false)
  })
})
