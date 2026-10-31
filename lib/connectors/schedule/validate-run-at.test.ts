import { describe, expect, it } from "vitest"
import { validateRunAt } from "@/connectors/schedule/validate-run-at"

const nowAt = (iso: string): (() => number) => {
  return () => Date.parse(iso)
}

describe("validateRunAt", () => {
  it("accepts a valid cron expression", () => {
    expect(validateRunAt("30 9 * * *", nowAt("2026-07-03T09:00:00Z"))).toBe("30 9 * * *")
  })

  it("accepts a future ISO timestamp", () => {
    expect(validateRunAt("2026-07-04T09:00:00Z", nowAt("2026-07-03T09:00:00Z"))).toBe(
      "2026-07-04T09:00:00Z",
    )
  })

  it("accepts a timestamp within the 60s grace window", () => {
    expect(validateRunAt("2026-07-03T08:59:30Z", nowAt("2026-07-03T09:00:00Z"))).toBe(
      "2026-07-03T08:59:30Z",
    )
  })

  it("uses the real clock by default", () => {
    expect(validateRunAt("2999-01-01T00:00:00Z")).toBe("2999-01-01T00:00:00Z")
  })

  it("rejects a past ISO timestamp", () => {
    expect(() => validateRunAt("2026-07-03T08:00:00Z", nowAt("2026-07-03T09:00:00Z"))).toThrow(
      /in the past/,
    )
  })

  it("rejects a timestamp just beyond the grace window", () => {
    expect(() => validateRunAt("2026-07-03T08:58:00Z", nowAt("2026-07-03T09:00:00Z"))).toThrow(
      /in the past/,
    )
  })

  it("rejects a space-separated timestamp with a hint to use the T separator", () => {
    expect(() => validateRunAt("2026-07-03 10:00", nowAt("2026-07-01T00:00:00Z"))).toThrow(
      /'T' separator, e\.g\. '2026-07-03T10:00'/,
    )
  })

  it("rejects garbage with the neither-cron-nor-ISO message", () => {
    expect(() => validateRunAt("tomorrow", nowAt("2026-07-03T09:00:00Z"))).toThrow(/neither/)
  })

  it("rejects malformed cron with the cron parser's message", () => {
    expect(() => validateRunAt("* * * *", nowAt("2026-07-03T09:00:00Z"))).toThrow(/5 fields/)
  })
})

it.each([
  "2050",
  "2050-01-01",
  "2050-01-01T09:00:00",
  "2050-02-29T09:00:00Z",
  "2050-04-31T09:00:00+09:00",
])("rejects ambiguous or normalized-away one-shot dates (%s)", (value) => {
  expect(() => validateRunAt(value, nowAt("2026-01-01T00:00:00Z"))).toThrow()
})
it.each([
  "2052-02-29T09:00:00+09:00",
  "2050-01-01T09:00+09:00",
  "2050-01-01T09:00Z",
  "2050-01-01T09:00:00.123-05:00",
  "2050-01-01t09:00z",
  "2050-01-01T09:00+0900",
  "2050-01-01T24:00:00Z",
])("keeps explicit-offset ISO precision and valid leap days (%s)", (value) => {
  expect(validateRunAt(value, nowAt("2026-01-01T00:00:00Z"))).toBe(value)
})
