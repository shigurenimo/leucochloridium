import { describe, expect, it } from "vitest"
import { commandOutputOverflowCallId } from "@/project/command-output-overflow-call-id"

describe("commandOutputOverflowCallId", () => {
  it.each([
    ["codex command output exceeded 200000 chars from call_12345", "call_12345"],
    [
      "codex command output exceeded 200000 chars from exec-b7c29f6c-a749-4ea8-974f-e7a60c60ec89",
      "exec-b7c29f6c-a749-4ea8-974f-e7a60c60ec89",
    ],
  ])("extracts supported call IDs from %s", (message, expected) => {
    expect(commandOutputOverflowCallId(new Error(message))).toBe(expected)
  })

  it("ignores unrelated errors", () => {
    expect(commandOutputOverflowCallId(new Error("codex child exited"))).toBeNull()
  })
})
