import type { ScheduleEntry } from "@/config/config-schema"

/**
 * Narrow port the `LeucoScheduleConnector` uses to read its entries,
 * delete one-shots after they fire, and persist per-entry `lastFiredAt` so
 * cron catch-up survives daemon restarts. Wired in production to the
 * `LeucoProjectStore` + `LeucoAgentStateStore` pair; tests pass a fake to
 * drive the connector without touching the filesystem.
 */
export type ScheduleStorePort = {
  /** Re-read the connector's entries every tick so CLI mutations are picked up. Throws on store error. */
  listEntries(): ScheduleEntry[]
  /** Remove one entry from settings.json after a one-shot fires. Throws on store error. */
  removeEntry(entryId: string): void
  /**
   * Epoch ms of the entry's last fire decision (written before the turn
   * runs, regardless of turn outcome), or `null` when the entry has never
   * fired. Returning `null` is treated
   * by the connector as "no across-restart catch-up" for that entry.
   */
  getLastFiredAt(entryId: string): number | null
  /** Record a fire decision so catch-up windows have a lower bound. */
  markFired(entryId: string, firedAt: number): void
}
