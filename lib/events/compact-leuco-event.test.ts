import { expect, it } from "vitest"
import { compactLeucoEvent } from "@/events/compact-leuco-event"

const prefix = "x".repeat(15_999)
const text = `${prefix}😀tail`
it("does not split a Unicode character in truncated turn input", () => {
  expect(
    compactLeucoEvent({
      ts: 1,
      type: "turn.start",
      threadKey: "cli",
      input: text,
    }),
  ).toMatchObject({ input: prefix, inputChars: text.length, inputTruncated: true })
})
it("does not split a Unicode character in truncated turn replies", () => {
  expect(
    compactLeucoEvent({
      ts: 1,
      type: "turn.complete",
      threadKey: "cli",
      reply: text,
    }),
  ).toMatchObject({ reply: prefix, replyChars: text.length, replyTruncated: true })
})
it("keeps truncated log lines and their marker within the limit", () => {
  const logPrefix = "x".repeat(15_987)
  const compacted = compactLeucoEvent({
    ts: 1,
    type: "log",
    level: "info",
    line: `${logPrefix}😀${"tail".repeat(10)}`,
  })
  expect(compacted).toMatchObject({ line: `${logPrefix} [truncated]` })
  if (compacted.type === "log") expect(compacted.line.length).toBeLessThanOrEqual(16_000)
})
