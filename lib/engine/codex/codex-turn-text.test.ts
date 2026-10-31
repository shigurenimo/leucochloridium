import { expect, it } from "vitest"
import {
  CodexTurnText,
  codexTurnTextMaxBytes,
  codexTurnTextMaxFragments,
} from "@/engine/codex/codex-turn-text"

it("preserves streamed, legacy, explicit-phase and final-answer precedence", () => {
  const text = new CodexTurnText()
  text.appendDelta("first")
  text.appendDelta(" second")
  expect(text.getText()).toBe("first second")
  text.complete("legacy", null)
  text.complete("next", undefined)
  expect(text.getText()).toBe("legacy\n\nnext")
  text.complete("commentary", "commentary")
  expect(text.getText()).toBe("")
  text.complete("final", "final_answer")
  text.complete("next final", "final_answer")
  expect(text.getText()).toBe("final\n\nnext final")
  text.clear()
  text.appendDelta("ignored by empty legacy answer")
  text.complete("", null)
  expect(text.getText()).toBe("")
})

it("counts UTF-8 bytes across retained stream and completed copies", () => {
  const text = new CodexTurnText()
  const half = "😀".repeat(codexTurnTextMaxBytes / 8)
  text.appendDelta(half)
  text.complete(half, "final_answer")
  expect(() => text.appendDelta("x")).toThrow("Codex turn text exceeded limit")
  expect(text.getText()).toBe(half)
  text.clear()
  text.appendDelta("after clear")
  expect(text.getText()).toBe("after clear")
})

it.each([null, "final_answer"])("bounds empty completed fragments with phase %j", (phase) => {
  const text = new CodexTurnText()
  for (const _ of Array.from({ length: codexTurnTextMaxFragments })) text.complete("", phase)
  expect(() => text.complete("", phase)).toThrow("Codex turn text exceeded limit")
  expect(text.getText()).toBe("\n\n".repeat(codexTurnTextMaxFragments - 1))
  text.clear()
  text.complete("fresh", phase)
  expect(text.getText()).toBe("fresh")
})

it.each([null, "final_answer"])(
  "does not retain a completed body that exceeds the limit: %j",
  (phase) => {
    const text = new CodexTurnText()
    text.appendDelta("retained")
    expect(() => text.complete("x".repeat(codexTurnTextMaxBytes + 1), phase)).toThrow(
      "Codex turn text exceeded limit",
    )
    expect(text.getText()).toBe("retained")
  },
)

it("does not retain empty deltas or discarded commentary bodies", () => {
  const text = new CodexTurnText()
  for (const _ of Array.from({ length: codexTurnTextMaxFragments + 1 })) text.appendDelta("")
  text.complete("x".repeat(codexTurnTextMaxBytes + 1), "commentary")
  text.complete("final", "final_answer")
  expect(text.getText()).toBe("final")
})
