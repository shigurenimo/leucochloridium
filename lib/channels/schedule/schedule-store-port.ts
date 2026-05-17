import type { ScheduleEntry } from "@/config/config-schema"

/**
 * Narrow port the `LeucoScheduleChannelPlugin` uses to read its entries,
 * delete one-shots after they fire, and persist per-entry `lastFiredAt` so
 * cron catch-up survives daemon restarts. Wired in production to the
 * `LeucoProjectStore` + `LeucoAgentStateStore` pair; tests pass a fake to
 * drive the plugin without touching the filesystem.
 */
export type ScheduleStorePort = {
  /** Re-read the channel's entries every tick so MCP/CLI mutations are picked up. Throws on store error. */
  listEntries(): ScheduleEntry[]
  /** Remove one entry from settings.json after a one-shot fires. Throws on store error. */
  removeEntry(entryId: string): void
  /**
   * Epoch ms of the entry's last successful fire, or `null` when the entry
   * has never fired (or its agent had no state.json yet). Returning `null`
   * is treated by the plugin as "no catch-up" — only one catch-up is
   * triggered per restart.
   */
  getLastFiredAt(entryId: string): number | null
  /** Record a fire so the next catch-up evaluation has a lower bound. */
  markFired(entryId: string, firedAt: number): void
}
