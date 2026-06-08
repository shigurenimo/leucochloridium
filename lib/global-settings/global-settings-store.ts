import { existsSync, readFileSync } from "node:fs"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { type GlobalSettings, globalSettingsSchema } from "@/global-settings/global-settings-schema"
import { LeucoPaths } from "@/paths/leuco-paths"

type Props = {
  paths?: LeucoPaths
}

/**
 * Read/write `~/.leuco/settings.json`. Missing file is treated as the schema
 * default (no settings written) so a fresh install works without bootstrap.
 *
 * `set()` accepts a raw CLI string, coerces it against the value's expected
 * type, then validates the merged settings via zod — invalid inputs return
 * `Error` so the CLI handler can surface a 400.
 */
export class LeucoGlobalSettingsStore {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  load(): GlobalSettings | Error {
    const path = this.paths.settingsPath()
    if (!existsSync(path)) return globalSettingsSchema.parse(undefined)

    try {
      const raw = readFileSync(path, "utf8")
      const json: unknown = JSON.parse(raw)
      return globalSettingsSchema.parse(json)
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  save(settings: GlobalSettings): string | Error {
    try {
      return atomicWriteJson({
        path: this.paths.settingsPath(),
        data: settings,
      })
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  set(key: string, rawValue: string): GlobalSettings | Error {
    const current = this.load()
    if (current instanceof Error) return current

    const coerced = coerceCliValue(rawValue)
    const next: Record<string, unknown> = { ...current, [key]: coerced }

    const parsed = globalSettingsSchema.safeParse(next)
    if (!parsed.success) {
      return new Error(`invalid ${key}=${rawValue}: ${parsed.error.message}`)
    }

    const saved = this.save(parsed.data)
    if (saved instanceof Error) return saved
    return parsed.data
  }
}

/**
 * Best-effort string → JSON-ish coercion for `leuco config set <key> <value>`.
 * Recognises booleans and finite numbers, otherwise passes the string through.
 * The schema validates the result, so unknown keys or wrong types still fail.
 */
const coerceCliValue = (raw: string): string | boolean | number => {
  if (raw === "true") return true
  if (raw === "false") return false

  const asNumber = Number(raw)
  if (raw.trim().length > 0 && Number.isFinite(asNumber)) return asNumber

  return raw
}
