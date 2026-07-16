import { AGENTS_MEMORY_PRESET } from "@/prompts/presets/agents-memory"
import { CORE_PRESET } from "@/prompts/presets/core"
import { ROLE_PROJECT_MANAGEMENT_PRESET } from "@/prompts/presets/role-project-management"
import { SECURITY_PRESET } from "@/prompts/presets/security"
import { STYLE_HUMAN_PRESET } from "@/prompts/presets/style-human"
import { STYLE_SLACK_PRESET } from "@/prompts/presets/style-slack"
import { STYLE_WORK_PRESET } from "@/prompts/presets/style-work"

export const PromptPreset = {
  CORE: CORE_PRESET.slug,
  SECURITY: SECURITY_PRESET.slug,
  ROLE_PROJECT_MANAGEMENT: ROLE_PROJECT_MANAGEMENT_PRESET.slug,
  STYLE_WORK: STYLE_WORK_PRESET.slug,
  STYLE_HUMAN: STYLE_HUMAN_PRESET.slug,
  STYLE_SLACK: STYLE_SLACK_PRESET.slug,
  AGENTS_MEMORY: AGENTS_MEMORY_PRESET.slug,
} as const

export type PromptPresetName = (typeof PromptPreset)[keyof typeof PromptPreset]

export const PROMPT_PRESET_NAMES = [
  PromptPreset.CORE,
  PromptPreset.SECURITY,
  PromptPreset.ROLE_PROJECT_MANAGEMENT,
  PromptPreset.STYLE_WORK,
  PromptPreset.STYLE_HUMAN,
  PromptPreset.STYLE_SLACK,
  PromptPreset.AGENTS_MEMORY,
] as const

export const DEFAULT_PROMPT_PRESET_NAMES = PROMPT_PRESET_NAMES

const PRESETS: Record<PromptPresetName, string> = {
  [PromptPreset.CORE]: CORE_PRESET.prompt,
  [PromptPreset.SECURITY]: SECURITY_PRESET.prompt,
  [PromptPreset.ROLE_PROJECT_MANAGEMENT]: ROLE_PROJECT_MANAGEMENT_PRESET.prompt,
  [PromptPreset.STYLE_WORK]: STYLE_WORK_PRESET.prompt,
  [PromptPreset.STYLE_HUMAN]: STYLE_HUMAN_PRESET.prompt,
  [PromptPreset.STYLE_SLACK]: STYLE_SLACK_PRESET.prompt,
  [PromptPreset.AGENTS_MEMORY]: AGENTS_MEMORY_PRESET.prompt,
}

/**
 * Static catalogue of named system-prompt presets the agent config can pick
 * from. Each preset is a chunk of markdown spliced into the developer
 * instructions after the dynamic preamble. Presets are intentionally
 * read-only here — to add or change one a contributor must drop a file under
 * `presets/` and register it below, which keeps the set reviewed and
 * discoverable.
 */
export class LeucoPromptPresets {
  static names(): readonly PromptPresetName[] {
    return PROMPT_PRESET_NAMES
  }

  static has(name: string): name is PromptPresetName {
    return (PROMPT_PRESET_NAMES as readonly string[]).includes(name)
  }

  static resolve(name: PromptPresetName): string {
    return PRESETS[name]
  }

  /**
   * Resolve every preset name to its body, skipping unknown names. Unknown
   * names are silently dropped because the schema already validates the
   * config; this is just a defensive guard for tests / callers that bypass
   * the schema.
   */
  static resolveAll(names: readonly string[]): string[] {
    const out: string[] = []
    for (const name of names) {
      if (LeucoPromptPresets.has(name)) {
        out.push(PRESETS[name])
      }
    }
    return out
  }
}
