import { describe, expect, it } from "vitest"
import { getCodexLogLevel } from "@/engine/codex/get-codex-log-level"

describe("Codex structured stderr severity", () => {
  it("preserves the structured severity without guessing from message contents", () => {
    expect(getCodexLogLevel('{"level":"WARN","fields":{"message":"startup"}}')).toBe("warn")
    expect(getCodexLogLevel('{"level":"ERROR","fields":{"message":"failed"}}')).toBe("error")
    expect(getCodexLogLevel('{"level":"INFO","fields":{"message":"ERROR in user text"}}')).toBe(
      "info",
    )
    expect(getCodexLogLevel("WARN: plain external text")).toBe("info")
    expect(getCodexLogLevel('{"level":')).toBe("info")
  })
})
