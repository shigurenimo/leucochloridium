import { expect, it } from "vitest"
import { compactLeucoEvent } from "@/events/compact-leuco-event"

const prefix = "x".repeat(15_999)
const text = `${prefix}😀tail`
it("does not split a Unicode character in truncated turn input", () => {
  expect(
    compactLeucoEvent({
      ts: 1,
      type: "turn.start",
      runtime: "leuco",
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
      runtime: "leuco",
      threadKey: "cli",
      reply: text,
    }),
  ).toMatchObject({ reply: prefix, replyChars: text.length, replyTruncated: true })
})
it("keeps the truncation marker after a complete Unicode prefix in log lines", () => {
  expect(compactLeucoEvent({ ts: 1, type: "log", level: "info", line: text })).toMatchObject({
    line: `${prefix} [truncated]`,
  })
})
it("does not split a Unicode character in notification previews", () => {
  const padding = "x".repeat(7_999 - '{"delta":"'.length)
  const params = { delta: `${padding}😀tail` }
  expect(
    compactLeucoEvent({
      ts: 1,
      type: "codex.notification",
      runtime: "leuco",
      method: "outputDelta",
      params,
    }),
  ).toMatchObject({
    params: {
      truncated: true,
      originalChars: JSON.stringify(params).length,
      preview: `{"delta":"${padding}`,
    },
  })
})
