import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { withFileLock } from "@/fs/with-file-lock"

describe("withFileLock", () => {
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-lock-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("runs the callback and releases the lock", () => {
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

  it("steals a stale lock", () => {
    const lockPath = join(dir, "settings.json.lock")
    mkdirSync(lockPath)
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockPath, past, past)

    const value = withFileLock({ lockPath, staleMs: 10_000 }, () => "ran")

    expect(value).toBe("ran")
    expect(existsSync(lockPath)).toBe(false)
  })

  it("throws when a fresh lock stays held past the timeout", () => {
    const lockPath = join(dir, "settings.json.lock")
    mkdirSync(lockPath)

    expect(() => withFileLock({ lockPath, timeoutMs: 50, staleMs: 60_000 }, () => "ran")).toThrow(
      "file lock busy",
    )

    rmSync(lockPath, { recursive: true, force: true })
  })
})
