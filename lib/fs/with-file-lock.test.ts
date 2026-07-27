import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withFileLock } from "@/fs/with-file-lock"

describe("withFileLock", () => {
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-lock-"))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it("holds the lock for the callback and releases it afterwards", () => {
    const lockPath = join(dir, "settings.json.lock")

    const value = withFileLock({ lockPath }, () => {
      expect(existsSync(lockPath)).toBe(true)
      return 42
    })

    expect(value).toBe(42)
    expect(existsSync(lockPath)).toBe(false)
  })

  it("releases the lock when the callback throws", () => {
    const lockPath = join(dir, "settings.json.lock")

    expect(() =>
      withFileLock({ lockPath }, () => {
        throw new Error("boom")
      }),
    ).toThrow("boom")
    expect(existsSync(lockPath)).toBe(false)
  })

  it("reclaims an abandoned stale lock", () => {
    const lockPath = join(dir, "settings.json.lock")
    writeFileSync(lockPath, `${JSON.stringify({ token: "abandoned", pid: 999_999_999 })}\n`)
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 999_999_999 && signal === 0) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" })
      }
      return true
    })

    expect(withFileLock({ lockPath, staleMs: 10_000 }, () => "ran")).toBe("ran")
  })

  it("reclaims a stale empty directory left by the legacy lock implementation", () => {
    const lockPath = join(dir, "settings.json.lock")
    mkdirSync(lockPath)
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)

    expect(withFileLock({ lockPath, staleMs: 10_000 }, () => "ran")).toBe("ran")
  })

  it("does not steal an old-looking lock while its owner process is alive", () => {
    const lockPath = join(dir, "settings.json.lock")

    withFileLock({ lockPath }, () => {
      const past = new Date(Date.now() - 60_000)
      utimesSync(lockPath, past, past)

      expect(() => withFileLock({ lockPath, timeoutMs: 30, staleMs: 1 }, () => "stolen")).toThrow(
        "file lock busy",
      )
    })
  })

  it("does not let an old holder remove a replacement holder's lock", () => {
    const lockPath = join(dir, "settings.json.lock")

    withFileLock({ lockPath }, () => {
      unlinkSync(lockPath)
      writeFileSync(lockPath, `${JSON.stringify({ token: "replacement", pid: process.pid })}\n`)
    })

    expect(existsSync(lockPath)).toBe(true)
  })

  it("fails with a bounded wait while a fresh lock remains held", () => {
    const lockPath = join(dir, "settings.json.lock")
    mkdirSync(lockPath)

    expect(() => withFileLock({ lockPath, timeoutMs: 30, staleMs: 60_000 }, () => null)).toThrow(
      "file lock busy",
    )
  })

  it("surfaces filesystem permission errors instead of reporting a busy lock", () => {
    const blockedDir = join(dir, "blocked")
    const lockPath = join(blockedDir, "settings.json.lock")
    mkdirSync(blockedDir)
    chmodSync(blockedDir, 0o000)

    let caught: unknown
    try {
      withFileLock({ lockPath, timeoutMs: 30 }, () => null)
    } catch (error) {
      caught = error
    } finally {
      chmodSync(blockedDir, 0o700)
    }

    expect(caught).toBeInstanceOf(Error)
    if (caught instanceof Error) {
      expect(caught.message).not.toContain("file lock busy")
    }
  })
})
