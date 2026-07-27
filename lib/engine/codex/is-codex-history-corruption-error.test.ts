import { describe, expect, it } from "vitest"
import { isCodexHistoryCorruptionError } from "@/engine/codex/is-codex-history-corruption-error"

describe("isCodexHistoryCorruptionError", () => {
  it("detects invalid tool arguments in reconstructed input history", () => {
    const error = new Error(
      "[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long",
    )

    expect(isCodexHistoryCorruptionError(error)).toBe(true)
  })

  it("does not reset a session for unrelated invalid requests", () => {
    expect(
      isCodexHistoryCorruptionError(new Error("invalid_request_error: model is not available")),
    ).toBe(false)
  })

  it("does not reset a session for transient turn failures", () => {
    expect(isCodexHistoryCorruptionError(new Error("codex turn timed out after 600s"))).toBe(false)
  })

  it.each([
    "authentication failed: 401",
    "network connection reset",
    "invalid_request_error: current input is too long",
  ])("does not classify a general failure as history corruption: %s", (message) => {
    expect(isCodexHistoryCorruptionError(new Error(message))).toBe(false)
  })
})
