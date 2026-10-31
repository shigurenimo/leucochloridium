import { afterEach, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

afterEach(() => vi.useRealTimers())

it.each([-1, 0, 0.5, NaN, Infinity, MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER])(
  "rejects an invalid schedule tick interval %s before starting",
  (intervalMs) => {
    vi.useFakeTimers()
    expect(
      () =>
        new LeucoScheduleConnector({
          intervalMs,
          store: {
            listEntries: () => [],
            removeEntry: () => false,
            getLastAttempt: () => null,
            markFired: () => {},
          },
        }),
    ).toThrow(`between 1 and ${MAX_TIMER_DELAY_MS}`)
    expect(vi.getTimerCount()).toBe(0)
  },
)

it.each([undefined, 1, MAX_TIMER_DELAY_MS])(
  "uses the valid tick cadence %s and clears it on stop",
  async (intervalMs) => {
    vi.useFakeTimers()
    const listEntries = vi.fn(() => [])
    const events = new LeucoEventLog()
    const connector = new LeucoScheduleConnector({
      intervalMs,
      store: {
        listEntries,
        removeEntry: () => false,
        getLastAttempt: () => null,
        markFired: () => {},
      },
    })
    try {
      await connector.start({
        eventLog: events,
        onLog: () => {},
        runTextTurn: async () => "",
      })
      await connector.waitForStartupTick()
      await vi.advanceTimersByTimeAsync((intervalMs ?? 60000) - 1)
      expect(listEntries).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(listEntries).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      await connector.stop()
      events.close()
    }
    expect(vi.getTimerCount()).toBe(0)
  },
)
