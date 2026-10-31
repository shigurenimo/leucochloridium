import { parseScheduleRunAt } from "@/connectors/schedule/parse-schedule-run-at"
import { z } from "zod"

const ONE_SHOT_DATE_SCHEMA = z.iso.date()

/**
 * Grace window for one-shot timestamps. "Run it now" flows often produce a
 * timestamp a few seconds in the past by the time it reaches validation;
 * only reject when the entry could never fire meaningfully.
 */
const PAST_GRACE_MS = 60_000

/**
 * Validate a `runAt` string before persisting it. Throws an `Error` describing
 * whether cron parsing or ISO parsing failed; otherwise returns the input
 * unchanged. Used by the CLI `schedules add` route.
 * `now` is injectable for tests and defaults to the real clock.
 */
export const validateRunAt = (runAt: string, now: () => number = () => Date.now()): string => {
  const ts = parseScheduleRunAt(runAt)
  if (ts === null) return runAt
  if (
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(runAt) ||
    !ONE_SHOT_DATE_SCHEMA.safeParse(runAt.slice(0, 10)).success
  )
    throw new Error(
      "runAt must be a real ISO 8601 date-time with Z or a numeric UTC offset, e.g. '2050-01-01T09:00:00+09:00'",
    )

  if (ts < now() - PAST_GRACE_MS) {
    throw new Error(`runAt timestamp is in the past: '${runAt}'`)
  }

  return runAt
}
