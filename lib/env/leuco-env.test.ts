import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LeucoEnv } from "@/env/leuco-env"

describe("LeucoEnv.loadFile", () => {
  let dir = ""

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-env-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns loaded=false for a missing file", () => {
    const env: NodeJS.ProcessEnv = {}
    const leuco = new LeucoEnv({ env })
    const result = leuco.loadFile(join(dir, "missing"))
    expect(result.loaded).toBe(false)
    expect(result.keys).toEqual([])
  })

  it("loads KEY=VALUE pairs into the env", () => {
    const path = join(dir, ".env")
    writeFileSync(path, "FOO=bar\nBAZ=qux\n")
    const env: NodeJS.ProcessEnv = {}
    const leuco = new LeucoEnv({ env })
    const result = leuco.loadFile(path)

    expect(result.loaded).toBe(true)
    expect(result.keys.sort()).toEqual(["BAZ", "FOO"])
    expect(env.FOO).toBe("bar")
    expect(env.BAZ).toBe("qux")
  })

  it("strips matching surrounding quotes", () => {
    const path = join(dir, ".env")
    writeFileSync(path, "A=\"quoted\"\nB='single'\nC=\"mixed'\n")
    const env: NodeJS.ProcessEnv = {}
    new LeucoEnv({ env }).loadFile(path)

    expect(env.A).toBe("quoted")
    expect(env.B).toBe("single")
    expect(env.C).toBe("\"mixed'")
  })

  it("does not overwrite existing env entries", () => {
    const path = join(dir, ".env")
    writeFileSync(path, "FOO=fromfile\n")
    const env: NodeJS.ProcessEnv = { FOO: "preset" }
    new LeucoEnv({ env }).loadFile(path)

    expect(env.FOO).toBe("preset")
  })

  it("ignores comments, blank lines, and malformed entries", () => {
    const path = join(dir, ".env")
    writeFileSync(path, "# comment\n\nFOO=ok\n=missingkey\n123BAD=skip\n")
    const env: NodeJS.ProcessEnv = {}
    const result = new LeucoEnv({ env }).loadFile(path)

    expect(result.keys).toEqual(["FOO"])
    expect(env.FOO).toBe("ok")
    expect(env["123BAD"]).toBeUndefined()
  })
})

describe("LeucoEnv.parseCli", () => {
  it("returns parsed CliEnv with optional LEUCO_PORT coerced", () => {
    const env: NodeJS.ProcessEnv = { LEUCO_PORT: "9743" }
    const result = new LeucoEnv({ env }).parseCli()
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.LEUCO_PORT).toBe(9743)
  })

  it("returns parsed CliEnv with no env vars set (all are optional now)", () => {
    const result = new LeucoEnv({ env: {} }).parseCli()
    expect(result).not.toBeInstanceOf(Error)
  })

  it("returns Error when LEUCO_PORT is not a positive integer", () => {
    const env: NodeJS.ProcessEnv = { LEUCO_PORT: "-1" }
    const result = new LeucoEnv({ env }).parseCli()
    expect(result).toBeInstanceOf(Error)
  })
})
