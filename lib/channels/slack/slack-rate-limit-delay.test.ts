import { describe, expect, it } from "vitest"
import { slackRateLimitDelayMs } from "@/channels/slack/slack-rate-limit-delay"

describe("slackRateLimitDelayMs", () => {
  it("converts retry-after seconds to milliseconds", () => {
    expect(slackRateLimitDelayMs("5")).toBe(5_000)
  })

  it("accepts zero", () => {
    expect(slackRateLimitDelayMs("0")).toBe(0)
  })

  it("caps the wait at 30 seconds", () => {
    expect(slackRateLimitDelayMs("9999")).toBe(30_000)
  })

  it("falls back to 1s when the header is missing", () => {
    expect(slackRateLimitDelayMs(null)).toBe(1_000)
  })

  it("falls back to 1s on an unparsable header", () => {
    expect(slackRateLimitDelayMs("soon")).toBe(1_000)
  })

  it("falls back to 1s on a negative value", () => {
    expect(slackRateLimitDelayMs("-3")).toBe(1_000)
  })
})
