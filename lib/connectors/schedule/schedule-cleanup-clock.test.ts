import { afterEach, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"

afterEach(() => vi.useRealTimers())

it.each([120000, -120000])(
  "starts cleanup backoff at the failure time after work shifts the clock by %i ms",
  async (shift) => {
    vi.useFakeTimers()
    const initial = Date.parse("2026-05-07T09:30:00Z")
    vi.setSystemTime(initial)
    const entry: ScheduleEntry = {
      id: "once",
      name: "once",
      runAt: "2026-05-07T09:00:00Z",
      prompt: "execute once",
      enabled: true,
    }
    const durable: {
      entries: ScheduleEntry[]
      attempt: { firedAt: number; runAt: string } | null
    } = { entries: [entry], attempt: null }
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const turns = vi.fn(async () => {
      started.resolve()
      await finished.promise
      return ""
    })
    const remove = vi.fn(() => {
      if (remove.mock.calls.length === 1)
        throw Object.assign(new Error("cleanup unavailable"), { code: "EACCES" })
      durable.entries = []
      return true
    })
    const logs: string[] = []
    const events = new LeucoEventLog()
    const connector = new LeucoScheduleConnector({
      store: {
        listEntries: () => durable.entries,
        getLastAttempt: () => durable.attempt,
        markFired: (_id, firedAt, runAt) => {
          durable.attempt = { firedAt, runAt }
        },
        removeEntry: remove,
      },
    })
    try {
      await connector.start({
        eventLog: events,
        onLog: (line) => {
          logs.push(line)
        },
        runTextTurn: turns,
      })
      await started.promise
      const failedAt = initial + shift
      vi.setSystemTime(failedAt)
      finished.resolve()
      await connector.waitForStartupTick()
      expect(remove).toHaveBeenCalledTimes(1)
      expect(connector.getStatus().cleanup).toEqual({ pending: 1, nextRetryAt: failedAt + 60000 })
      expect(logs.some((line) => line.includes("cleanup retry #1 in 60s"))).toBe(true)
      vi.setSystemTime(failedAt + 1)
      await connector.tickOnce()
      expect(remove).toHaveBeenCalledTimes(1)
      expect(connector.getStatus().state).toBe("error")
      expect(connector.getStatus().lastFailure).toEqual({
        ts: failedAt,
        message: "cleanup unavailable",
      })
      vi.setSystemTime(failedAt + 60000)
      await connector.tickOnce()
      expect(remove).toHaveBeenCalledTimes(2)
      expect(durable.entries).toEqual([])
      expect(connector.getStatus().cleanup).toEqual({ pending: 0, nextRetryAt: null })
      expect(connector.getStatus().state).toBe("ready")
      expect(connector.getStatus().lastFailure).toBeNull()
      expect(turns).toHaveBeenCalledTimes(1)
    } finally {
      finished.resolve()
      await connector.stop()
      events.close()
    }
  },
)
