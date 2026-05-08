import { z } from "zod"

/**
 * Machine-wide leuco settings that live in `~/.leuco/settings.json`.
 *
 * Per-project settings live in `~/.leuco/projects/<p>/settings.json` and are
 * unrelated. Keep this surface small and explicitly typed so `leuco config
 * set` can coerce CLI strings against it without surprises.
 */
export const globalSettingsSchema = z
  .object({
    /**
     * macOS only: when true, the daemon is launched under `caffeinate -is`
     * so the system stays awake while leuco runs. `-i` blocks idle sleep and
     * `-s` blocks system/clamshell sleep on AC power (no-op on battery).
     * Ignored on non-darwin.
     */
    keepAwake: z.boolean().default(true),
  })
  .default({ keepAwake: true })

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export type GlobalSettingsKey = keyof GlobalSettings
