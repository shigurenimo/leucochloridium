import { looksLikeCron, parseCronExpression } from "@/channels/schedule/cron-expression"

/**
 * Validate a `runAt` string before persisting it. Throws an `Error` describing
 * whether cron parsing or ISO parsing failed; otherwise returns the input
 * unchanged. Used by both the CLI `schedules add` route and the MCP
 * `schedule_create` tool so the two paths reject the same garbage.
 */
export const validateRunAt = (runAt: string): string => {
  if (looksLikeCron(runAt)) {
    parseCronExpression(runAt)
    return runAt
  }

  const ts = Date.parse(runAt)
  if (Number.isNaN(ts)) {
    throw new Error(
      `runAt is neither a 5-field cron expression nor an ISO 8601 timestamp: '${runAt}'`,
    )
  }
  return runAt
}
