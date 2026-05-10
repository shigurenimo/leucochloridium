import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LeucoHumanFileWriter } from "@/logger/leuco-human-file-writer"

describe("LeucoHumanFileWriter", () => {
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "leuco-human-"))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("appends one JSON line per record", () => {
    const path = join(tmp, "append.log")
    const w = new LeucoHumanFileWriter({ path })

    w.write({ ts: 1, level: "info", message: "a", meta: null })
    w.write({ ts: 2, level: "warn", message: "b", meta: { x: 1 } })

    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 1,
      level: "info",
      message: "a",
      meta: null,
    })
    expect(JSON.parse(lines[1]!)).toEqual({
      ts: 2,
      level: "warn",
      message: "b",
      meta: { x: 1 },
    })
  })

  it("creates parent directories on construct", () => {
    const path = join(tmp, "deep", "nested", "file.log")
    const w = new LeucoHumanFileWriter({ path })

    w.write({ ts: 1, level: "info", message: "hi", meta: null })

    expect(existsSync(path)).toBe(true)
  })

  it("rotates to .1 when maxBytes is exceeded", () => {
    const path = join(tmp, "rotate.log")
    const w = new LeucoHumanFileWriter({ path, maxBytes: 200 })

    for (const i of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      w.write({
        ts: i,
        level: "info",
        message: `padding-padding-padding-padding-${i}`,
        meta: null,
      })
    }

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(statSync(path).size).toBeGreaterThan(0)
    expect(statSync(`${path}.1`).size).toBeGreaterThan(0)
  })
})
