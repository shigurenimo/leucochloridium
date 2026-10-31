import { encodeLocalJson } from "@/fs/encode-local-json"
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
    encodeLocalJson(this.settings)
  }

  loadSettings(): LeucoSettings {
    return structuredClone(this.settings)
  }
  loadState(): LeucoState {
    return structuredClone(this.state)
  }

  updateSettings(transform: (settings: LeucoSettings) => LeucoSettings): void {
    const next = settingsSchema.parse(transform(this.loadSettings()))
    encodeLocalJson(next)
    this.settings = next
  }

  updateState(transform: (state: LeucoState) => LeucoState): void {
    const next = stateSchema.parse(transform(this.loadState()))
    encodeLocalJson(next)
    this.state = next
  }

  readInstructions(path: string): string {
    const text = this.instructions.get(path)
    if (text === undefined) throw new Error(`Instructions file not found: ${path}`)
    return text
  }
}
