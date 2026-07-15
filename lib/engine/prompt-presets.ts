import { AGENTS_MEMORY_PROMPT } from "@/engine/prompt-presets/agents-memory"
import { COMMUNICATION_SLACK_PROMPT } from "@/engine/prompt-presets/communication-slack"
import { CORE_PROMPT } from "@/engine/prompt-presets/core"
import { HUMAN_COMMUNICATION_PROMPT } from "@/engine/prompt-presets/human-communication"
import { SECURITY_PROMPT } from "@/engine/prompt-presets/security"
import { WORK_COMMUNICATION_PROMPT } from "@/engine/prompt-presets/work-communication"

export const PromptPreset = {
  CORE: "CORE",
  SECURITY: "SECURITY",
  WORK_COMMUNICATION: "WORK_COMMUNICATION",
  HUMAN_COMMUNICATION: "HUMAN_COMMUNICATION",
  COMMUNICATION_SLACK: "COMMUNICATION_SLACK",
  AGENTS_MEMORY: "AGENTS_MEMORY",
} as const

export type PromptPresetName = (typeof PromptPreset)[keyof typeof PromptPreset]

export const PROMPT_PRESET_NAMES = [
  PromptPreset.CORE,
  PromptPreset.SECURITY,
  PromptPreset.WORK_COMMUNICATION,
  PromptPreset.HUMAN_COMMUNICATION,
  PromptPreset.COMMUNICATION_SLACK,
  PromptPreset.AGENTS_MEMORY,
] as const

export const DEFAULT_PROMPT_PRESET_NAMES = PROMPT_PRESET_NAMES

const PRESETS: Record<PromptPresetName, string> = {
  [PromptPreset.CORE]: CORE_PROMPT,
  [PromptPreset.SECURITY]: SECURITY_PROMPT,
  [PromptPreset.WORK_COMMUNICATION]: WORK_COMMUNICATION_PROMPT,
  [PromptPreset.HUMAN_COMMUNICATION]: HUMAN_COMMUNICATION_PROMPT,
  [PromptPreset.COMMUNICATION_SLACK]: COMMUNICATION_SLACK_PROMPT,
  [PromptPreset.AGENTS_MEMORY]: AGENTS_MEMORY_PROMPT,
}

/**
 * Static catalogue of named system-prompt presets the agent config can pick
 * from. Each preset is a chunk of markdown spliced into the developer
 * instructions after the dynamic preamble. Presets are intentionally
 * read-only here — to add or change one a contributor must drop a file under
 * `prompt-presets/` and register it below, which keeps the set reviewed and
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
