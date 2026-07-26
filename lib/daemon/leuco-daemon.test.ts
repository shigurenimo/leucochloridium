import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
import { LeucoPaths } from "@/paths/leuco-paths"

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

  it("treats EPERM from kill(pid, 0) as a live process", () => {
    writeFileSync(paths.daemonPidPath(), "12345\n")
    vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (pid === 12345 && signal === 0) {
        const error = new Error("permission denied") as NodeJS.ErrnoException
        error.code = "EPERM"
        throw error
      }
      return true
    }) as typeof process.kill)

    const status = new LeucoDaemon({ paths }).status()

    expect(status.pid).toBe(12345)
    expect(status.isRunning).toBe(true)
  })

  it("treats ESRCH from kill(pid, 0) as a stale process", () => {
    writeFileSync(paths.daemonPidPath(), "12345\n")
    vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
      if (pid === 12345 && signal === 0) {
        const error = new Error("no such process") as NodeJS.ErrnoException
        error.code = "ESRCH"
        throw error
      }
      return true
    }) as typeof process.kill)

    const status = new LeucoDaemon({ paths }).status()

    expect(status.pid).toBe(12345)
    expect(status.isRunning).toBe(false)
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
})
