import { describe, expect, it } from "vitest"
import {
  LeucoPromptPresets,
  PROMPT_PRESET_NAMES,
  PromptPreset,
} from "@/engine/prompt-presets"

describe("LeucoPromptPresets", () => {
  it("registers CORE, COMMUNICATION, and COMMUNICATION_SLACK as known presets", () => {
    expect(PROMPT_PRESET_NAMES).toContain(PromptPreset.CORE)
    expect(PROMPT_PRESET_NAMES).toContain(PromptPreset.COMMUNICATION)
    expect(PROMPT_PRESET_NAMES).toContain(PromptPreset.COMMUNICATION_SLACK)
    expect(LeucoPromptPresets.has(PromptPreset.CORE)).toBe(true)
    expect(LeucoPromptPresets.has(PromptPreset.COMMUNICATION)).toBe(true)
    expect(LeucoPromptPresets.has(PromptPreset.COMMUNICATION_SLACK)).toBe(true)
  })

  it("rejects unknown preset names", () => {
    expect(LeucoPromptPresets.has("nope")).toBe(false)
  })

  it("resolves CORE to a body covering stance and safety", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.CORE)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Core behaviour")
    expect(body).toContain("Stance")
    expect(body).toContain("Safety")
    expect(body).not.toMatch(/slack/i)
  })

  it("resolves COMMUNICATION to a reply-style body free of channel specifics", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.COMMUNICATION)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Communication style")
    expect(body).toContain("Reply style")
    expect(body).not.toMatch(/slack/i)
  })

  it("resolves COMMUNICATION_SLACK to a Slack-specific body", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.COMMUNICATION_SLACK)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Slack conventions")
    expect(body).toContain("thread_ts")
  })

  it("resolveAll returns the bodies of every recognised name and silently drops unknowns", () => {
    const out = LeucoPromptPresets.resolveAll([
      PromptPreset.CORE,
      "ghost",
      PromptPreset.COMMUNICATION,
      PromptPreset.COMMUNICATION_SLACK,
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toContain("Core behaviour")
    expect(out[1]).toContain("Communication style")
    expect(out[2]).toContain("Slack conventions")
  })

  it("resolveAll on an empty list returns an empty array", () => {
    expect(LeucoPromptPresets.resolveAll([])).toEqual([])
  })
})
