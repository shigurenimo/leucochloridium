import { describe, expect, it } from "vitest"
import { validateRunAt } from "@/channels/schedule/validate-run-at"

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
