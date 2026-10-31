import { describe, expect, it } from "vitest"
import { CodexStderrLog } from "@/engine/codex/codex-stderr-log"

describe("Codex stderr line framing", () => {
  it("joins split JSON and token text before logging, then flushes the final unterminated line", () => {
    const emitted: Array<{ line: string; level: string }> = []
    const log = new CodexStderrLog((line, level) => emitted.push({ line, level }))
    log.write('{"level":"WA')
    log.write('RN","fields":{"message":"xoxb-synthetic-')
    expect(emitted).toEqual([])
    log.write('token"}}\r\nlast line')
    expect(emitted).toEqual([
      { line: '{"level":"WARN","fields":{"message":"xoxb-synthetic-token"}}', level: "warn" },
    ])
    log.flush()
    log.flush()
    expect(emitted[1]).toEqual({ line: "last line", level: "info" })
    expect(emitted).toHaveLength(2)
  })
  it("bounds an unterminated line, reports truncation and recovers at the next newline", () => {
    const emitted: Array<{ line: string; level: string }> = []
    const log = new CodexStderrLog((line, level) => emitted.push({ line, level }))
    for (const _ of Array.from({ length: 100 })) log.write("x".repeat(1000))
    expect(emitted).toEqual([])
    log.write('\n{"level":"ERROR"}\n')
    expect(emitted[0]?.line.length).toBeLessThan(16_000)
    expect(emitted[0]?.line).toContain("truncated")
    expect(emitted[0]?.level).toBe("warn")
    expect(emitted[1]).toEqual({ line: '{"level":"ERROR"}', level: "error" })
  })
})

it("omits oversized stderr without exposing a partial Unicode character", () => {
  const emitted: string[] = []
  const log = new CodexStderrLog((line) => emitted.push(line))
  const original = `${"p".repeat(11999)}😀discarded`
  log.write(`${original}\nnext\n`)
  expect(emitted).toEqual([
    `[truncated stderr line; content omitted before redaction; original chars=${original.length}]`,
    "next",
  ])
})
it("does not fill a dropped Unicode boundary with unrelated later stderr chunks", () => {
  const emitted: string[] = []
  const log = new CodexStderrLog((line) => emitted.push(line))
  const original = `${"p".repeat(11999)}😀discarded`
  const continuation = "tail-must-not-fill-the-gap"
  log.write(original)
  log.write(`${continuation}\n`)
  expect(emitted).toEqual([
    `[truncated stderr line; content omitted before redaction; original chars=${original.length + continuation.length}]`,
  ])
})
it("retains a Unicode character that fits completely at the stderr limit", () => {
  const emitted: string[] = []
  const log = new CodexStderrLog((line) => emitted.push(line))
  const original = `${"p".repeat(11998)}😀`
  log.write(`${original}\n`)
  expect(emitted).toEqual([original])
})

it("never publishes a secret prefix when a secret crosses the retained stderr boundary", () => {
  const secret = "synthetic-private-owner-credential"
  const emitted: string[] = []
  const log = new CodexStderrLog((line) => emitted.push(line.split(secret).join("[redacted]")))
  log.write(`${"p".repeat(11990)}${secret.slice(0, 10)}`)
  log.write(`${secret.slice(10)} discarded\nnext\n`)
  expect(emitted[0]).not.toContain(secret.slice(0, 10))
  expect(emitted[0]).toContain("content omitted before redaction")
  expect(emitted[1]).toBe("next")
})
