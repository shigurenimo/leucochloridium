import { describe, expect, it } from "vitest"
import { LeucoPromptPresets, PROMPT_PRESET_NAMES } from "@/engine/prompt-presets"

describe("LeucoPromptPresets", () => {
  it("registers `friendly` as a known preset", () => {
    expect(PROMPT_PRESET_NAMES).toContain("friendly")
    expect(LeucoPromptPresets.has("friendly")).toBe(true)
  })

  it("rejects unknown preset names", () => {
    expect(LeucoPromptPresets.has("nope")).toBe(false)
  })

  it("resolves a known preset to a non-empty markdown body", () => {
    const body = LeucoPromptPresets.resolve("friendly")
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Friendly Slack persona")
  })

  it("resolveAll returns the bodies of every recognised name and silently drops unknowns", () => {
    const out = LeucoPromptPresets.resolveAll(["friendly", "ghost", "friendly"])
    expect(out).toHaveLength(2)
    expect(out[0]).toContain("Friendly Slack persona")
    expect(out[1]).toContain("Friendly Slack persona")
  })

  it("resolveAll on an empty list returns an empty array", () => {
    expect(LeucoPromptPresets.resolveAll([])).toEqual([])
  })
})
