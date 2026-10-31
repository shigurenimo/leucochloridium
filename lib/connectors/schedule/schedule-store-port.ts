import type { ScheduleEntry } from "@/config/config-schema"

/**
 * Narrow port the `LeucoScheduleConnector` uses to read its entries,
 * delete one-shots after they fire, and persist per-entry `lastFiredAt` so
 * cron catch-up survives daemon restarts. Wired in production to the
 * `LeucoStore` settings and state; tests pass a fake to
 * drive the connector without touching the filesystem.
 */
export type ScheduleStorePort = {
  /** Re-read the connector's entries every tick so CLI mutations are picked up. Throws on store error. */
  listEntries(): ScheduleEntry[]
  /** Atomically remove only the attempted ID + runAt. False means changed or absent. Throws on store error. */
  removeEntry(entryId: string, expectedRunAt: string): boolean
  /**
   * Last durable decision and its scheduled time, or null if never attempted.
   * runAt is null for legacy records that contain only an epoch timestamp.
   * Read both fields from the same state snapshot.
   */
  getLastAttempt(entryId: string): { firedAt: number; runAt: string | null } | null
  /** Atomically record the decision and scheduled time before dispatch. */
  markFired(entryId: string, firedAt: number, runAt: string): void
}
