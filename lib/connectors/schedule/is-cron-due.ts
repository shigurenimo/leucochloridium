import type { FlumeCron } from "@interactive-inc/flume/time"
import { flumeCronNext } from "@interactive-inc/flume/time"

const MINUTE_MS = 60_000

export function isCronDue(cron: FlumeCron, date: Date): boolean {
  const minuteStart = Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS
  const next = flumeCronNext(cron, minuteStart - MINUTE_MS)

  return !(next instanceof Error) && next === minuteStart
}
