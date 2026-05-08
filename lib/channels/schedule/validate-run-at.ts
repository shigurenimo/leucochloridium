import { looksLikeCron, parseCronExpression } from "@/channels/schedule/cron-expression"

/**
 * Validate a `runAt` string before persisting it. Returns the input unchanged
 * on success, or an `Error` describing whether cron parsing or ISO parsing
 * failed. Used by both the CLI `schedules add` route and the MCP
 * `schedule_create` tool so the two paths reject the same garbage.
 */
export const validateRunAt = (runAt: string): string | Error => {
  if (looksLikeCron(runAt)) {
    const expr = parseCronExpression(runAt)
    if (expr instanceof Error) return expr
    return runAt
  }

  const ts = Date.parse(runAt)
  if (Number.isNaN(ts)) {
    return new Error(
      `runAt is neither a 5-field cron expression nor an ISO 8601 timestamp: '${runAt}'`,
    )
  }
  return runAt
}
