import { CodexRpcError } from "@/engine/codex/codex-rpc-error"
import { describe, expect, it } from "vitest"
import { isCodexHistoryCorruptionError } from "@/engine/codex/is-codex-history-corruption-error"

describe("isCodexHistoryCorruptionError", () => {
  it("detects invalid tool arguments in reconstructed input history", () => {
    const error = new CodexRpcError(
      -32600,
      "[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long",
    )

    expect(isCodexHistoryCorruptionError(error)).toBe(true)
  })

  it("does not discard history for local or internal failures with matching text", () => {
    const message =
      "[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long"
    expect(isCodexHistoryCorruptionError(new Error(message))).toBe(false)
    expect(isCodexHistoryCorruptionError(new CodexRpcError(-32603, message))).toBe(false)
    expect(isCodexHistoryCorruptionError(new CodexRpcError(429, message))).toBe(false)
    const quoted = new CodexRpcError(-32600, "model is unavailable")
    quoted.message = message
    expect(isCodexHistoryCorruptionError(quoted)).toBe(false)
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
