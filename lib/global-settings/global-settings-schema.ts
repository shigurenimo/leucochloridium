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
const globalSettingsShape = {
  /**
   * macOS only: when true, the daemon is launched under `caffeinate -is`
   * so the system stays awake while leuco runs. `-i` blocks idle sleep and
   * `-s` blocks system/clamshell sleep on AC power (no-op on battery).
   * Ignored on non-darwin.
   */
  keepAwake: z.boolean().default(true),
  projects: z
    .array(projectSchema)
    .default([])
    .superRefine((projects, ctx) => {
      // Two projects sharing an id would share CODEX_HOME and the /mcp/<id>
      // route and silently overwrite each other's config.toml — fail loudly.
      const seen = new Set<string>()
      for (const project of projects) {
        if (seen.has(project.id)) {
          ctx.addIssue({ code: "custom", message: `duplicate project id: ${project.id}` })
        }
        seen.add(project.id)
      }
    }),
}

/**
 * `passthrough` keeps top-level keys this binary does not know about, so an
 * older leuco writing the file after a newer one does not silently strip the
 * newer version's fields.
 */
export const globalSettingsSchema = z
  .object(globalSettingsShape)
  .passthrough()
  .default({ keepAwake: true, projects: [] })

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export type GlobalSettingsKey = keyof typeof globalSettingsShape

export const GLOBAL_SETTINGS_KEYS: ReadonlyArray<GlobalSettingsKey> = ["keepAwake", "projects"]
