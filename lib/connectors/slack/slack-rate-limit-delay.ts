const DEFAULT_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

/**
 * How long to wait before the single retry after a Slack 429. Retry-After is
 * in seconds; a missing or unparsable header falls back to 1s, and the wait
 * is capped at 30s so a hostile or broken header cannot stall the caller.
 */
export const slackRateLimitDelayMs = (retryAfterHeader: string | null): number => {
  if (retryAfterHeader === null) return DEFAULT_DELAY_MS

  const seconds = Number(retryAfterHeader.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_DELAY_MS

  return Math.min(seconds * 1_000, MAX_DELAY_MS)
}
