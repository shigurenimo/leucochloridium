import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { atomicWriteText } from "@/fs/atomic-write-text"

describe("atomicWriteText", () => {
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-atomic-text-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("atomically replaces text with the requested restrictive mode", () => {
    const path = join(dir, "config.toml")

    atomicWriteText({ path, text: 'token = "old"\n', mode: 0o600 })
    atomicWriteText({ path, text: 'token = "new"\n', mode: 0o600 })

    expect(readFileSync(path, "utf8")).toBe('token = "new"\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })

  it("writes the complete UTF-8 payload before publishing the destination", () => {
    const path = join(dir, "config.toml")
    const text = `instructions = "${"応答を失わない".repeat(32_768)}"\n`

    atomicWriteText({ path, text, mode: 0o600 })

    expect(readFileSync(path, "utf8")).toBe(text)
  })

  it("cleans up its temporary file if the destination cannot be replaced", () => {
    const path = join(dir, "config.toml")
    mkdirSync(path)

    expect(() => atomicWriteText({ path, text: "secret", mode: 0o600 })).toThrow()
    expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })
})
