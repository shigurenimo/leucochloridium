import { settingsSchema, stateSchema } from "@/config/config-schema"
import type { LeucoSettings, LeucoState } from "@/config/config-schema"
import { LeucoStore } from "@/storage/leuco-store"

export class MemoryLeucoStore extends LeucoStore {
  private settings: LeucoSettings
  private state: LeucoState = stateSchema.parse({})
  readonly instructions = new Map<string, string>()

  constructor(settings: Partial<LeucoSettings> = {}) {
    super()
    this.settings = settingsSchema.parse(settings)
  }

  loadSettings(): LeucoSettings {
    return structuredClone(this.settings)
  }
  loadState(): LeucoState {
    return structuredClone(this.state)
  }

  updateSettings(transform: (settings: LeucoSettings) => LeucoSettings): void {
    this.settings = settingsSchema.parse(transform(this.loadSettings()))
  }

  updateState(transform: (state: LeucoState) => LeucoState): void {
    this.state = stateSchema.parse(transform(this.loadState()))
  }

  readInstructions(path: string): string {
    const text = this.instructions.get(path)
    if (text === undefined) throw new Error(`Instructions file not found: ${path}`)
    return text
  }
}
