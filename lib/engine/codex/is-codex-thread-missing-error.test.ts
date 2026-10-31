import { describe, expect, it } from "vitest"
import { CodexRpcError } from "@/engine/codex/codex-rpc-error"
import { isCodexThreadMissingError } from "@/engine/codex/is-codex-thread-missing-error"

describe("isCodexThreadMissingError", () => {
  it.each([
    "no rollout found for thread id saved-thread",
    "thread saved-thread not found",
    "thread not found: saved-thread",
    "no such thread: saved-thread",
  ])("recognizes a matching server invalid-request response: %s", (message) => {
    expect(isCodexThreadMissingError(new CodexRpcError(-32600, message), "saved-thread")).toBe(true)
  })

  it.each([
    "model not found: configured-model",
    "credential not found",
    "no thread permission",
    "no rollout found for thread id other-thread",
    "thread saved-thread not found because database is unavailable",
    "failed to read config: thread saved-thread not found",
  ])("retains the conversation for an unrelated or ambiguous error: %s", (message) => {
    expect(isCodexThreadMissingError(new CodexRpcError(-32600, message), "saved-thread")).toBe(
      false,
    )
  })

  it("requires a server response with the expected error code", () => {
    const message = "thread saved-thread not found"
    expect(isCodexThreadMissingError(new Error(message), "saved-thread")).toBe(false)
    expect(isCodexThreadMissingError(new CodexRpcError(-32603, message), "saved-thread")).toBe(
      false,
    )
    const error = new CodexRpcError(-32600, message)
    expect(error.message).toBe(`${message} (code -32600)`)
  })
})
