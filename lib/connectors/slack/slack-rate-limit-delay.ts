export const SLACK_RATE_LIMIT_DEFAULT_DELAY_MS = 1_000
export const SLACK_RATE_LIMIT_MAX_DELAY_MS = 30_000

/**
 * How long to wait before the single retry after a Slack 429. Retry-After is
 * in seconds; a missing, blank or unparsable header falls back to 1s, and the wait
 * is capped at 30s so a hostile or broken header cannot stall the caller.
 */
export const slackRateLimitDelayMs = (retryAfterHeader: string | null): number => {
  if (retryAfterHeader === null) return SLACK_RATE_LIMIT_DEFAULT_DELAY_MS

  const header = retryAfterHeader.trim()
  if (!/^[0-9]+$/.test(header)) return SLACK_RATE_LIMIT_DEFAULT_DELAY_MS

  const seconds = Number(header)
  // A valid decimal can overflow to Infinity; cap it before creating a timer.
  return Math.min(seconds * 1_000, SLACK_RATE_LIMIT_MAX_DELAY_MS)
}
