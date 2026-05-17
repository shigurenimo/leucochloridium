import type { ScheduleEntry } from "@/config/config-schema"

/**
 * Narrow port the `LeucoScheduleChannelPlugin` uses to read its entries and
 * delete one-shots after they fire. Wired in production to `LeucoProjectStore`
 * (which writes back to settings.json); tests pass a fake to drive the plugin
 * without touching the filesystem.
 */
export type ScheduleStorePort = {
  /** Re-read the channel's entries every tick so MCP/CLI mutations are picked up. Throws on store error. */
  listEntries(): ScheduleEntry[]
  /** Remove one entry from settings.json after a one-shot fires. Throws on store error. */
  removeEntry(entryId: string): void
}
