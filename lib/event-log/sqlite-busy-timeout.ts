import type { Database } from "bun:sqlite"

/**
 * How long a writer waits for another process's lock before failing. The
 * daemon and short-lived CLI processes open the same files; without a timeout
 * the first write on open (WAL switch, schema migration) fails instantly with
 * `database is locked` whenever the daemon happens to be writing.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000

/** Must run before any statement that may need a lock. */
export function applySqliteBusyTimeout(db: Database, timeoutMs = SQLITE_BUSY_TIMEOUT_MS): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
    throw new Error("SQLite busyTimeoutMs must be a nonnegative integer within the timer range")
  db.run(`PRAGMA busy_timeout = ${timeoutMs}`)
}
