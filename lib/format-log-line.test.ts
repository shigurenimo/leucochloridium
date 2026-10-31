import { expect, it } from "vitest"
import { formatLogLine } from "@/format-log-line"

it("preserves ordinary readable text and structured quotes", () => {
  expect(formatLogLine('[info] {"message":"接続済み → ready 😀"}')).toBe(
    '[info] {"message":"接続済み → ready 😀"}',
  )
})

it("keeps multiline and terminal-control content in one physical record", () => {
  const formatted = formatLogLine("first\nforged\rhidden\u001b[2J\u0000\tend")
  expect(formatted).toBe("first\\nforged\\rhidden\\u001b[2J\\u0000\\tend")
  expect(formatted).not.toMatch(/[\u0000-\u001f]/u)
})

it("makes literal backslashes distinguishable from escaped controls", () => {
  expect(formatLogLine("\\n")).toBe("\\\\n")
  expect(formatLogLine("\n")).toBe("\\n")
})

it("escapes Unicode line separators and C1 terminal controls", () => {
  expect(formatLogLine("a\u2028b\u2029c\u009b31m")).toBe("a\\u2028b\\u2029c\\u009b31m")
})

it("masks tokens before the clipping boundary", () => {
  const formatted = formatLogLine(`${"x".repeat(15997)} xoxb-sensitive-value ${"x".repeat(200)}`)
  expect(formatted).not.toContain("xox")
  expect(formatted).not.toContain("sensitive-value")
  expect(formatted).toContain("truncated log entry")
})

it("bounds escaped output without splitting emoji or escape sequences", () => {
  const emoji = formatLogLine(`a${"😀".repeat(9000)}`)
  expect(emoji.isWellFormed()).toBe(true)
  expect(emoji).toContain("truncated log entry")
  const controls = formatLogLine("\u001b".repeat(16000))
  expect(controls.length).toBeLessThan(16100)
  expect(controls.split(" [truncated")[0]!.length % 6).toBe(0)
})
