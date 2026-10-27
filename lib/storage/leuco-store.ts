import type { LeucoSettings, LeucoState } from "@/config/config-schema"

export abstract class LeucoStore {
  abstract loadSettings(): LeucoSettings
  abstract updateSettings(transform: (settings: LeucoSettings) => LeucoSettings): void
  abstract loadState(): LeucoState
  abstract updateState(transform: (state: LeucoState) => LeucoState): void
  abstract readInstructions(path: string): string
}
