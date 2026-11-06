import { type FlumeCron, parseCron } from "@interactive-inc/flume/time"
import { isCronSchedule } from "@/connectors/schedule/is-cron-schedule"

export type ScheduleRunAt = { kind: "cron"; cron: FlumeCron } | { kind: "one-shot"; at: number }

/** Parse a stored `runAt` as cron or a one-shot epoch timestamp; throw when it is neither. */
export function parseScheduleRunAt(runAt: string): ScheduleRunAt {
  if (isCronSchedule(runAt)) {
    const parsed = parseCron(runAt)
    if (parsed instanceof Error) {
      if (!Number.isNaN(Date.parse(runAt))) {
        const suggested = runAt.trim().replace(/\s+/, "T")
        throw new Error(
          `runAt looks like a timestamp with a space separator: '${runAt}'. Use ISO 8601 with a 'T' separator, e.g. '${suggested}', and include Z or a numeric UTC offset`,
        )
      }
      throw parsed
    }
    return { kind: "cron", cron: parsed }
  }
  const timestamp = Date.parse(runAt)
  if (Number.isNaN(timestamp))
    throw new Error(
      `runAt is neither a 5-field cron expression nor an ISO 8601 timestamp: '${runAt}'`,
    )
  return { kind: "one-shot", at: timestamp }
}
