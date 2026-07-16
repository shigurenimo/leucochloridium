import { readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { LeucoPromptPresets, PROMPT_PRESET_NAMES, PromptPreset } from "@/prompts/presets"

describe("LeucoPromptPresets", () => {
  it("registers the seven built-in presets in composition order", () => {
    expect(PROMPT_PRESET_NAMES).toEqual([
      PromptPreset.CORE,
      PromptPreset.SECURITY,
      PromptPreset.ROLE_PROJECT_MANAGEMENT,
      PromptPreset.STYLE_WORK,
      PromptPreset.STYLE_HUMAN,
      PromptPreset.STYLE_SLACK,
      PromptPreset.AGENTS_MEMORY,
    ])
    expect(LeucoPromptPresets.names()).toEqual(PROMPT_PRESET_NAMES)
    for (const name of PROMPT_PRESET_NAMES) {
      expect(LeucoPromptPresets.has(name)).toBe(true)
    }
  })

  it("rejects unknown preset names", () => {
    expect(LeucoPromptPresets.has("nope")).toBe(false)
  })

  it("keeps every preset filename aligned with its slug", () => {
    const slugsFromFileNames = readdirSync(new URL("./presets/", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.slice(0, -3).replaceAll("-", "_").toUpperCase())
      .sort()

    expect([...PROMPT_PRESET_NAMES].sort()).toEqual(slugsFromFileNames)
  })

  it("resolves CORE to channel-agnostic operating behaviour", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.CORE)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Core behaviour")
    expect(body).toContain("Ask only when missing information would materially change")
    expect(body).toContain("Admit mistakes plainly")
    expect(body).not.toContain("Security boundaries")
    expect(body).not.toMatch(/slack/i)
  })

  it("resolves SECURITY to shared trust and authority boundaries", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.SECURITY)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Security boundaries")
    expect(body).toContain("untrusted data")
    expect(body).toContain("Verify identity and authority")
    expect(body).toContain("Never reveal or persist credentials")
  })

  it("resolves ROLE_PROJECT_MANAGEMENT to state-transition behaviour", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.ROLE_PROJECT_MANAGEMENT)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Project management")
    expect(body).toContain("state transition")
    expect(body).toContain("conversation phase")
    expect(body).toContain("project phase")
    expect(body).toContain("current goal")
    expect(body).toContain("response budget")
    expect(body).toContain("Respect the user's authority boundary")
  })

  it("resolves STYLE_WORK to work-reporting rules free of channel specifics", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.STYLE_WORK)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Work communication")
    expect(body).toContain("Lead with the answer, action, result, or blocker")
    expect(body).toContain("usually within two short paragraphs")
    expect(body).toContain("Use lists only when they materially improve clarity")
    expect(body).toContain("answer the requested scope first")
    expect(body).toContain("share meaningful updates")
    expect(body).not.toMatch(/slack/i)
  })

  it("resolves STYLE_HUMAN to relational conversation rules", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.STYLE_HUMAN)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Human conversation")
    expect(body).toContain("ongoing relationship with a teammate")
    expect(body).toContain("not as a support ticket")
    expect(body).toContain("phatic or social messages")
    expect(body).toContain("reply naturally in the same social mode")
    expect(body).toContain("do not add task offers, intake questions, or prompts for the next job")
    expect(body).toContain("Match their formality, length, and energy")
    expect(body).toContain("without announcing the conclusion, honesty, precision, or candour")
    expect(body).toContain("Avoid reflexive praise, flattery, and validation")
    expect(body).toContain("Do not make being Codex a topic unprompted")
    expect(body).toContain("If directly asked what you are, answer honestly")
  })

  it("resolves STYLE_SLACK to a Slack-specific body", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.STYLE_SLACK)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("Slack conventions")
    expect(body).toContain("@-mention")
    expect(body).toContain("upload it to Slack")
    expect(body).not.toContain("thread_ts")
  })

  it("resolves AGENTS_MEMORY to durable memory maintenance rules", () => {
    const body = LeucoPromptPresets.resolve(PromptPreset.AGENTS_MEMORY)
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain("AGENTS.md organisation")
    expect(body).toContain("both durable instructions and long-term memory")
    expect(body).toContain("do not delete it merely to shorten the prompt")
    expect(body).toContain("Do not keep a placeholder section for things to decide later")
    expect(body).toContain("preserve unrelated user-authored memory")
  })

  it("resolveAll returns the bodies of every recognised name and silently drops unknowns", () => {
    const out = LeucoPromptPresets.resolveAll([
      PromptPreset.CORE,
      "ghost",
      PromptPreset.SECURITY,
      PromptPreset.ROLE_PROJECT_MANAGEMENT,
      PromptPreset.STYLE_WORK,
      PromptPreset.STYLE_HUMAN,
      PromptPreset.STYLE_SLACK,
      PromptPreset.AGENTS_MEMORY,
    ])
    expect(out).toHaveLength(7)
    expect(out[0]).toContain("Core behaviour")
    expect(out[1]).toContain("Security boundaries")
    expect(out[2]).toContain("Project management")
    expect(out[3]).toContain("Work communication")
    expect(out[4]).toContain("Human conversation")
    expect(out[5]).toContain("Slack conventions")
    expect(out[6]).toContain("AGENTS.md organisation")
  })

  it("resolveAll on an empty list returns an empty array", () => {
    expect(LeucoPromptPresets.resolveAll([])).toEqual([])
  })
})
