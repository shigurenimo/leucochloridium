import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { LeucoTurnTimeouts } from "@/engine/turn-timeouts"
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it.each(["hardTimeoutMs", "idleTimeoutMs"])(
  "rejects overflowing %s before creating any timer",
  (key) => {
    expect(
      () =>
        new LeucoTurnTimeouts({
          hardTimeoutMs: 1000,
          idleTimeoutMs: 1000,
          [key]: 2147483648,
          clock: { setTimeout, clearTimeout },
        }),
    ).toThrow(/2147483647/)
    expect(vi.getTimerCount()).toBe(0)
  },
)
it("does not fire valid upper-bound timers after a few milliseconds", async () => {
  const deadlines = new LeucoTurnTimeouts({
    hardTimeoutMs: 2147483647,
    idleTimeoutMs: 2147483647,
    clock: { setTimeout, clearTimeout },
  })
  const fired = { hard: false, idle: false }
  void deadlines.hardTimeout.then(() => {
    fired.hard = true
  })
  void deadlines.idleTimeout.then(() => {
    fired.idle = true
  })
  deadlines.startIdle()
  await vi.advanceTimersByTimeAsync(30)
  expect(fired).toEqual({ hard: false, idle: false })
  deadlines.clear()
  expect(vi.getTimerCount()).toBe(0)
})
