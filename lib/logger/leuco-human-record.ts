export type LeucoHumanLevel = "info" | "warn" | "error"

/**
 * One human-facing diagnostic log entry. Distinct from `LeucoLoggerRecord`
 * (which wraps a schema-validated domain event) — this is the free-form,
 * for-humans-tailing-a-log shape: a level, a message, and optional meta.
 *
 * `meta` is `null` rather than `undefined` when absent so writers can
 * persist a uniform shape (no missing-key ambiguity in JSON Lines).
 */
export type LeucoHumanRecord = {
  ts: number
  level: LeucoHumanLevel
  message: string
  meta: Record<string, unknown> | null
}
