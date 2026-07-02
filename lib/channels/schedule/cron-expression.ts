/**
 * Minimal 5-field cron expression parser/matcher.
 *
 * Field order: minute hour day-of-month month day-of-week.
 *
 * Each field accepts:
 *   - `*`           every value in range
 *   - `<n>`         exact integer
 *   - `<a>-<b>`     inclusive range
 *   - `*\/<n>`      every n values from the field's minimum
 *   - `<n>/<s>`     from n to the field's maximum, step s (Vixie semantics)
 *   - `<a>,<b>,..`  comma list of any of the above (no nested commas)
 *
 * Day-of-week uses 0..6 with 0 = Sunday. Match semantics: when both
 * day-of-month and day-of-week are restricted, a date matches if EITHER
 * matches — the standard Vixie cron behavior. When one is `*`, only the
 * other constrains the day. A `*\/<n>` step counts as a RESTRICTED field
 * for this OR rule even though its base is `*`.
 *
 * Matching uses machine-local wall-clock time. Across DST transitions this
 * means nonexistent local times (spring-forward) skip that day, and repeated
 * local times (fall-back) can match — and thus fire — twice.
 *
 * Parse failures throw — callers wrap in try/catch (e.g. schedule plugin's
 * tickOnce) so a single malformed entry does not stall the loop.
 */

type FieldRange = { min: number; max: number }

const MINUTE: FieldRange = { min: 0, max: 59 }
const HOUR: FieldRange = { min: 0, max: 23 }
const DAY_OF_MONTH: FieldRange = { min: 1, max: 31 }
const MONTH: FieldRange = { min: 1, max: 12 }
const DAY_OF_WEEK: FieldRange = { min: 0, max: 6 }

export type CronField = {
  /** Sorted unique values the field accepts. */
  values: ReadonlyArray<number>
  /** True iff the original token was `*` — needed for dom/dow OR semantics. */
  wildcard: boolean
}

export type CronExpression = {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

export const parseCronExpression = (text: string): CronExpression => {
  const tokens = text.trim().split(/\s+/)
  if (tokens.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${tokens.length}: '${text}'`)
  }

  const minute = parseField(tokens[0]!, MINUTE, "minute")
  const hour = parseField(tokens[1]!, HOUR, "hour")
  const dayOfMonth = parseField(tokens[2]!, DAY_OF_MONTH, "day-of-month")
  const month = parseField(tokens[3]!, MONTH, "month")
  const dayOfWeek = parseField(tokens[4]!, DAY_OF_WEEK, "day-of-week")

  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

/**
 * True iff the supplied date matches the expression at minute granularity.
 * Seconds and milliseconds of `date` are ignored.
 */
export const cronMatches = (expr: CronExpression, date: Date): boolean => {
  if (!expr.minute.values.includes(date.getMinutes())) return false
  if (!expr.hour.values.includes(date.getHours())) return false
  if (!expr.month.values.includes(date.getMonth() + 1)) return false

  const domMatches = expr.dayOfMonth.values.includes(date.getDate())
  const dowMatches = expr.dayOfWeek.values.includes(date.getDay())

  if (expr.dayOfMonth.wildcard && expr.dayOfWeek.wildcard) return true
  if (expr.dayOfMonth.wildcard) return dowMatches
  if (expr.dayOfWeek.wildcard) return domMatches
  return domMatches || dowMatches
}

/**
 * Detect whether `text` looks like a cron expression rather than something
 * else (an ISO timestamp, a number, etc). Heuristic: cron is the only
 * representation that contains internal whitespace.
 */
export const looksLikeCron = (text: string): boolean => {
  return /\s/.test(text.trim())
}

const parseField = (token: string, range: FieldRange, label: string): CronField => {
  const parts = token.split(",")
  const acc = new Set<number>()
  let wildcard = false

  for (const part of parts) {
    const expanded = expandPart(part, range, label)
    if (expanded.wildcard) wildcard = true
    for (const value of expanded.values) acc.add(value)
  }

  const values = [...acc].sort((a, b) => a - b)
  if (values.length === 0) throw new Error(`cron ${label}: no values for '${token}'`)

  return { values, wildcard }
}

const expandPart = (
  part: string,
  range: FieldRange,
  label: string,
): { values: number[]; wildcard: boolean } => {
  const stepSplit = part.split("/")
  if (stepSplit.length > 2) throw new Error(`cron ${label}: malformed step '${part}'`)

  const base = stepSplit[0]!
  const stepText = stepSplit[1]

  let step = 1
  if (stepText !== undefined) {
    let parsed: number
    try {
      parsed = parsePositiveInt(stepText)
    } catch {
      throw new Error(`cron ${label}: bad step '${stepText}'`)
    }
    if (parsed < 1) throw new Error(`cron ${label}: step must be >= 1, got ${parsed}`)
    step = parsed
  }

  const span = expandBase(base, range, label)

  // Vixie cron: a single value with a step (`5/2`) means "from 5 to the
  // field's maximum, step 2" — not just [5]. Ranges and `*` keep their span.
  const isSingleValueBase = base !== "*" && !base.includes("-")
  const to = stepText !== undefined && isSingleValueBase ? range.max : span.to

  const values: number[] = []
  for (let v = span.from; v <= to; v += step) values.push(v)

  const wildcard = base === "*" && step === 1
  return { values, wildcard }
}

const expandBase = (
  base: string,
  range: FieldRange,
  label: string,
): { from: number; to: number } => {
  if (base === "*") return { from: range.min, to: range.max }

  if (base.includes("-")) {
    const dashSplit = base.split("-")
    if (dashSplit.length !== 2) throw new Error(`cron ${label}: malformed range '${base}'`)
    let from: number
    let to: number
    try {
      from = parsePositiveInt(dashSplit[0]!)
    } catch {
      throw new Error(`cron ${label}: bad range start '${base}'`)
    }
    try {
      to = parsePositiveInt(dashSplit[1]!)
    } catch {
      throw new Error(`cron ${label}: bad range end '${base}'`)
    }
    if (from < range.min || to > range.max || from > to) {
      throw new Error(`cron ${label}: range '${base}' outside ${range.min}-${range.max}`)
    }
    return { from, to }
  }

  let single: number
  try {
    single = parsePositiveInt(base)
  } catch {
    throw new Error(`cron ${label}: bad value '${base}'`)
  }
  if (single < range.min || single > range.max) {
    throw new Error(`cron ${label}: '${base}' outside ${range.min}-${range.max}`)
  }
  return { from: single, to: single }
}

const parsePositiveInt = (text: string): number => {
  if (!/^\d+$/.test(text)) throw new Error(`not an integer: '${text}'`)
  return Number.parseInt(text, 10)
}
