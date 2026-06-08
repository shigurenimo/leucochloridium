import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { atomicWriteJson } from "@/fs/atomic-write-json"

describe("atomicWriteJson", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-atomic-write-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes JSON pretty-printed with a trailing newline", () => {
    const path = join(dir, "out.json")
    atomicWriteJson({ path, data: { name: "leuco", n: 3 } })

    const text = readFileSync(path, "utf8")
    expect(text).toBe('{\n  "name": "leuco",\n  "n": 3\n}\n')
  })

  test("creates missing parent directories", () => {
    const path = join(dir, "nested", "deeper", "out.json")
    atomicWriteJson({ path, data: { ok: true } })

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ok: true })
  })

  test("applies the optional mode before the rename", () => {
    const path = join(dir, "secret.json")
    atomicWriteJson({ path, data: { token: "x" }, mode: 0o600 })

    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test("leaves an existing file untouched when write fails", () => {
    const path = join(dir, "out.json")
    writeFileSync(path, '{"original": true}\n')

    // Force JSON.stringify to throw by feeding it a circular value.
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => atomicWriteJson({ path, data: circular })).toThrow()
    expect(readFileSync(path, "utf8")).toBe('{"original": true}\n')
  })

  test("cleans up the temp file when write throws", () => {
    const path = join(dir, "out.json")

    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(() => atomicWriteJson({ path, data: circular })).toThrow()

    const remainingTemps = readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))
    expect(remainingTemps).toEqual([])
  })

  test("overwrites an existing destination", () => {
    const path = join(dir, "out.json")
    atomicWriteJson({ path, data: { v: 1 } })
    atomicWriteJson({ path, data: { v: 2 } })

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ v: 2 })
  })
})
