import { existsSync, readFileSync, statSync, chmodSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { settingsSchema, stateSchema } from "@/config/config-schema"
import type { LeucoSettings, LeucoState } from "@/config/config-schema"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { withFileLock } from "@/fs/with-file-lock"
import { LeucoStore } from "@/storage/leuco-store"

export class NodeLeucoStore extends LeucoStore {
  readonly home: string

  constructor(home: string) {
    super()
    this.home = resolve(home)
    Object.freeze(this)
  }

  loadSettings(): LeucoSettings {
    const path = join(this.home, "settings.json")
    if (!existsSync(path)) return settingsSchema.parse({})
    const document: unknown = JSON.parse(readFileSync(path, "utf8"))
    return settingsSchema.parse(document)
  }

  updateSettings(transform: (settings: LeucoSettings) => LeucoSettings): void {
    this.ensureHome()
    withFileLock({ lockPath: join(this.home, "settings.lock") }, () => {
      atomicWriteJson({
        path: join(this.home, "settings.json"),
        data: settingsSchema.parse(transform(this.loadSettings())),
        mode: 0o600,
      })
    })
  }

  loadState(): LeucoState {
    const path = join(this.home, "state.json")
    if (!existsSync(path)) return stateSchema.parse({})
    return stateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  }

  updateState(transform: (state: LeucoState) => LeucoState): void {
    this.ensureHome()
    withFileLock({ lockPath: join(this.home, "state.lock") }, () => {
      atomicWriteJson({
        path: join(this.home, "state.json"),
        data: stateSchema.parse(transform(this.loadState())),
        mode: 0o600,
      })
    })
  }

  readInstructions(path: string): string {
    if (statSync(path).size > 256 * 1024) throw new Error("Instructions file exceeds 256 KiB")
    return readFileSync(path, "utf8")
  }

  ensureHome(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 })
    chmodSync(this.home, 0o700)
  }
}
