import { looksLikeCron, parseCronExpression } from "@/channels/schedule/cron-expression"

/**
 * Grace window for one-shot timestamps. "Run it now" flows often produce a
 * timestamp a few seconds in the past by the time it reaches validation;
 * only reject when the entry could never fire meaningfully.
 */
const PAST_GRACE_MS = 60_000

/**
 * Validate a `runAt` string before persisting it. Throws an `Error` describing
 * whether cron parsing or ISO parsing failed; otherwise returns the input
 * unchanged. Used by both the CLI `schedules add` route and the MCP
 * `schedule_create` tool so the two paths reject the same garbage.
 * `now` is injectable for tests and defaults to the real clock.
 */
export const validateRunAt = (runAt: string, now: () => number = () => Date.now()): string => {
  if (looksLikeCron(runAt)) {
    try {
      parseCronExpression(runAt)
    } catch (err) {
      // A space-separated timestamp like "2026-07-03 10:00" contains
      // whitespace, so it lands in the cron branch and would otherwise die
      // with a confusing "must have 5 fields". Point at the ISO form instead.
      if (!Number.isNaN(Date.parse(runAt))) {
        const suggested = runAt.trim().replace(/\s+/, "T")
        throw new Error(
          `runAt looks like a timestamp with a space separator: '${runAt}'. Use ISO 8601 with a 'T' separator, e.g. '${suggested}'`,
        )
      }
      throw err
    }
    return runAt
  }

  const ts = Date.parse(runAt)
  if (Number.isNaN(ts)) {
    throw new Error(
      `runAt is neither a 5-field cron expression nor an ISO 8601 timestamp: '${runAt}'`,
    )
  }

  if (ts < now() - PAST_GRACE_MS) {
    throw new Error(`runAt timestamp is in the past: '${runAt}'`)
  }

  return runAt
}
