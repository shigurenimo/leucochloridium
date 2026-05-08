import { describe, expect, it } from "vitest"
import {
  type CronExpression,
  cronMatches,
  looksLikeCron,
  parseCronExpression,
} from "@/channels/schedule/cron-expression"

const ok = (text: string): CronExpression => {
  const expr = parseCronExpression(text)
  if (expr instanceof Error) throw expr
  return expr
}

describe("parseCronExpression", () => {
  it("parses all wildcards", () => {
    const expr = ok("* * * * *")
    expect(expr.minute.values.length).toBe(60)
    expect(expr.minute.wildcard).toBe(true)
    expect(expr.hour.values.length).toBe(24)
    expect(expr.dayOfMonth.values.length).toBe(31)
    expect(expr.month.values.length).toBe(12)
    expect(expr.dayOfWeek.values.length).toBe(7)
  })

  it("parses exact integers", () => {
    const expr = ok("5 9 1 1 1")
    expect(expr.minute.values).toEqual([5])
    expect(expr.hour.values).toEqual([9])
    expect(expr.dayOfMonth.values).toEqual([1])
    expect(expr.month.values).toEqual([1])
    expect(expr.dayOfWeek.values).toEqual([1])
    expect(expr.minute.wildcard).toBe(false)
  })

  it("parses ranges", () => {
    const expr = ok("0 9-11 * * *")
    expect(expr.hour.values).toEqual([9, 10, 11])
  })

  it("parses comma lists", () => {
    const expr = ok("0,15,30,45 * * * *")
    expect(expr.minute.values).toEqual([0, 15, 30, 45])
  })

  it("parses step expressions", () => {
    const expr = ok("*/15 * * * *")
    expect(expr.minute.values).toEqual([0, 15, 30, 45])
    expect(expr.minute.wildcard).toBe(false)
  })

  it("parses range with step", () => {
    const expr = ok("0 9-17/4 * * *")
    expect(expr.hour.values).toEqual([9, 13, 17])
  })

  it("dedupes and sorts comma list", () => {
    const expr = ok("30,5,5,15 * * * *")
    expect(expr.minute.values).toEqual([5, 15, 30])
  })

  it("rejects wrong field count", () => {
    expect(parseCronExpression("* * * *")).toBeInstanceOf(Error)
    expect(parseCronExpression("* * * * * *")).toBeInstanceOf(Error)
  })

  it("rejects out of range", () => {
    expect(parseCronExpression("60 * * * *")).toBeInstanceOf(Error)
    expect(parseCronExpression("* 24 * * *")).toBeInstanceOf(Error)
    expect(parseCronExpression("* * 0 * *")).toBeInstanceOf(Error)
    expect(parseCronExpression("* * * 13 *")).toBeInstanceOf(Error)
    expect(parseCronExpression("* * * * 7")).toBeInstanceOf(Error)
  })

  it("rejects malformed range", () => {
    expect(parseCronExpression("9-1 * * * *")).toBeInstanceOf(Error)
    expect(parseCronExpression("a-b * * * *")).toBeInstanceOf(Error)
  })

  it("rejects step 0", () => {
    expect(parseCronExpression("*/0 * * * *")).toBeInstanceOf(Error)
  })
})

describe("cronMatches", () => {
  it("matches every minute on `* * * * *`", () => {
    const expr = ok("* * * * *")
    expect(cronMatches(expr, new Date("2026-05-07T12:34:00Z"))).toBe(true)
  })

  it("matches exact minute/hour", () => {
    const expr = ok("30 9 * * *")
    expect(cronMatches(expr, new Date(2026, 4, 7, 9, 30))).toBe(true)
    expect(cronMatches(expr, new Date(2026, 4, 7, 9, 29))).toBe(false)
    expect(cronMatches(expr, new Date(2026, 4, 7, 10, 30))).toBe(false)
  })

  it("ignores seconds", () => {
    const expr = ok("0 * * * *")
    expect(cronMatches(expr, new Date(2026, 4, 7, 12, 0, 45))).toBe(true)
    expect(cronMatches(expr, new Date(2026, 4, 7, 12, 0, 0))).toBe(true)
  })

  it("OR-merges dom and dow when both restricted", () => {
    // 5th of month OR Friday at 09:00
    const expr = ok("0 9 5 * 5")
    expect(cronMatches(expr, new Date(2026, 4, 5, 9, 0))).toBe(true)
    expect(cronMatches(expr, new Date(2026, 4, 8, 9, 0))).toBe(
      new Date(2026, 4, 8, 9, 0).getDay() === 5,
    )
    expect(cronMatches(expr, new Date(2026, 4, 6, 9, 0))).toBe(false)
  })

  it("uses dow only when dom is wildcard", () => {
    // every Monday at 09:00
    const expr = ok("0 9 * * 1")
    const monday = new Date(2026, 4, 4, 9, 0)
    const tuesday = new Date(2026, 4, 5, 9, 0)
    expect(monday.getDay()).toBe(1)
    expect(cronMatches(expr, monday)).toBe(true)
    expect(cronMatches(expr, tuesday)).toBe(false)
  })

  it("uses dom only when dow is wildcard", () => {
    const expr = ok("0 9 15 * *")
    expect(cronMatches(expr, new Date(2026, 4, 15, 9, 0))).toBe(true)
    expect(cronMatches(expr, new Date(2026, 4, 16, 9, 0))).toBe(false)
  })

  it("matches month bounds", () => {
    const expr = ok("0 0 1 1 *")
    expect(cronMatches(expr, new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches(expr, new Date(2026, 1, 1, 0, 0))).toBe(false)
  })
})

describe("looksLikeCron", () => {
  it("returns true for whitespace-bearing strings", () => {
    expect(looksLikeCron("* * * * *")).toBe(true)
    expect(looksLikeCron("0 9 * * 1")).toBe(true)
  })

  it("returns false for ISO timestamps", () => {
    expect(looksLikeCron("2026-05-07T09:00:00Z")).toBe(false)
    expect(looksLikeCron("2026-05-07T09:00:00+09:00")).toBe(false)
  })
})
