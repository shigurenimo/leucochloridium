import { expect, it } from "vitest"
import { formatCodexConsumerError } from "@/engine/codex/format-codex-consumer-error"
import { redactPublicText } from "@/secrets/redact-public-text"

it("masks a complete registered secret before bounding fallback diagnostics", () => {
  const secret = "private-consumer-credential"
  const formatted = formatCodexConsumerError({
    kind: "log",
    error: new Error(`${"p".repeat(3988)}${secret}tail`),
    redactLogText: (text) => redactPublicText(text, [secret]),
  })
  expect(formatted).not.toContain("private-")
  expect(formatted.length).toBeLessThanOrEqual(4000)
  expect(formatted).toContain("[truncated]")
})
it("masks URL credentials and escapes line and terminal controls", () => {
  const formatted = formatCodexConsumerError({
    kind: "notification",
    error: new Error("wss://user:password@host.example/path?ticket=private-ticket\n\u001b[2J"),
  })
  expect(formatted).toContain("wss://[redacted]@host.example/path?[redacted]")
  expect(formatted).not.toMatch(/[\n\r\u001b]/)
})
it("keeps valid Unicode within its display budget", () => {
  const formatted = formatCodexConsumerError({ kind: "log", error: new Error("😀".repeat(3000)) })
  expect(formatted.isWellFormed()).toBe(true)
  expect(formatted.length).toBeLessThanOrEqual(4000)
  expect(formatted).toContain("[truncated]")
})
it("omits raw diagnostics if a supplied redactor fails", () => {
  expect(
    formatCodexConsumerError({
      kind: "notification",
      error: new Error("private-original"),
      redactLogText: () => {
        throw new Error("private-redactor")
      },
    }),
  ).toBe("[codex notification consumer failed] [diagnostic omitted: redaction failed]")
})
