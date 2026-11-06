import { describe, expect, it } from "vitest"
import { isCronDue } from "@/connectors/schedule/is-cron-due"
import { isCronSchedule } from "@/connectors/schedule/is-cron-schedule"
import { latestScheduleCatchup } from "@/connectors/schedule/latest-schedule-catchup"
import { parseScheduleRunAt } from "@/connectors/schedule/parse-schedule-run-at"

const parse = (expression: string) => {
  const schedule = parseScheduleRunAt(expression)
  if (schedule.kind !== "cron") throw new Error(`invalid test cron: ${expression}`)

  return schedule.cron
}

describe("schedule time", () => {
  it("matches cron at minute resolution", () => {
    const cron = parse("30 9 * * *")

    expect(isCronDue(cron, new Date(2026, 4, 7, 9, 30, 45))).toBe(true)
    expect(isCronDue(cron, new Date(2026, 4, 7, 9, 31))).toBe(false)
  })

  it("uses Flume's standard Sunday alias", () => {
    const sunday = new Date(2026, 4, 3, 9, 0)

    expect(sunday.getDay()).toBe(0)
    expect(isCronDue(parse("0 9 * * 7"), sunday)).toBe(true)
  })

  it("rejects malformed cron and parses one-shots to epoch milliseconds", () => {
    expect(() => parseScheduleRunAt("not a cron")).toThrow()
    expect(parseScheduleRunAt("2026-05-07T09:00:00Z")).toEqual({
      kind: "one-shot",
      at: Date.parse("2026-05-07T09:00:00Z"),
    })
  })

  it("finds the newest missed tick inside the bounded catch-up window", () => {
    const now = new Date(2026, 4, 7, 12, 0).getTime()
    const latest = latestScheduleCatchup({
      cron: parse("30 9 * * *"),
      lastFiredAt: new Date(2026, 4, 5, 9, 30).getTime(),
      now: now - 1,
      maxWindowMs: 24 * 60 * 60 * 1000,
    })

    expect(latest).toBe(new Date(2026, 4, 7, 9, 30).getTime())
  })

  it("distinguishes ISO timestamps from cron expressions", () => {
    expect(isCronSchedule("* * * * *")).toBe(true)
    expect(isCronSchedule("2026-05-07T09:00:00Z")).toBe(false)
  })
})
