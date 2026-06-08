import { z } from "zod"
import { projectSchema } from "@/config/config-schema"

/**
 * Machine-wide leuco settings that live in `~/.leuco/settings.json`.
 * The `projects` array holds every registered project — including
 * per-channel secrets (Slack tokens), so the file is chmod 600.
 *
 * `leuco config set/get` operates only on the scalar keys (keepAwake
 * etc.); the projects array is managed exclusively by LeucoProjectStore.
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
    projects: z.array(projectSchema).default([]),
  })
  .default({ keepAwake: true, projects: [] })

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export type GlobalSettingsKey = keyof GlobalSettings
