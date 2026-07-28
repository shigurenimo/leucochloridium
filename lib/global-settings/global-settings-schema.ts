import { z } from "zod"
import { projectSchema } from "@/config/config-schema"
import {
  DEFAULT_TURN_CONCURRENCY,
  DEFAULT_TURN_IDLE_TIMEOUT_MS,
  DEFAULT_TURN_QUEUE_MAX_BYTES,
  DEFAULT_TURN_QUEUE_MAX_ITEMS,
  DEFAULT_TURN_TIMEOUT_MS,
} from "@/engine/turn-timeouts"

/**
 * Machine-wide leuco settings that live in `~/.leuco/settings.json`.
 * The `projects` array holds every registered project — including
 * per-connector secrets (Slack tokens), so the file is chmod 600.
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
  /** Maximum wall-clock for one Codex turn before the child is replaced. */
  turnTimeoutMs: z.number().int().min(1_000).default(DEFAULT_TURN_TIMEOUT_MS),
  /** Maximum time without a Codex notification before treating a turn as stalled. */
  turnIdleTimeoutMs: z.number().int().min(1_000).default(DEFAULT_TURN_IDLE_TIMEOUT_MS),
  /** Maximum different conversation threads one project may run concurrently. */
  turnConcurrency: z.number().int().min(1).max(32).default(DEFAULT_TURN_CONCURRENCY),
  /** Maximum turns retained while a project runtime already has work in flight. */
  turnQueueMaxItems: z.number().int().min(1).default(DEFAULT_TURN_QUEUE_MAX_ITEMS),
  /** Maximum UTF-8 bytes retained across a project runtime's pending turns. */
  turnQueueMaxBytes: z.number().int().min(1_024).default(DEFAULT_TURN_QUEUE_MAX_BYTES),
  projects: z
    .array(projectSchema)
    .default([])
    .superRefine((projects, ctx) => {
      // Two projects sharing an id would share CODEX_HOME and silently
      // overwrite each other's config.toml — fail loudly.
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
export const globalSettingsSchema = z.object(globalSettingsShape).passthrough().default({
  keepAwake: true,
  turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  turnIdleTimeoutMs: DEFAULT_TURN_IDLE_TIMEOUT_MS,
  turnConcurrency: DEFAULT_TURN_CONCURRENCY,
  turnQueueMaxItems: DEFAULT_TURN_QUEUE_MAX_ITEMS,
  turnQueueMaxBytes: DEFAULT_TURN_QUEUE_MAX_BYTES,
  projects: [],
})

export type GlobalSettings = z.infer<typeof globalSettingsSchema>

export type GlobalSettingsKey = keyof typeof globalSettingsShape

export const GLOBAL_SETTINGS_KEYS: ReadonlyArray<GlobalSettingsKey> = [
  "keepAwake",
  "turnTimeoutMs",
  "turnIdleTimeoutMs",
  "turnConcurrency",
  "turnQueueMaxItems",
  "turnQueueMaxBytes",
  "projects",
]
