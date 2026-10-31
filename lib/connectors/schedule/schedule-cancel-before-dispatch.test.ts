import { afterEach, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each(["event", "text"])(
  "does not dispatch or replay when the %s diagnostic stops a recorded schedule",
  async (phase) => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse("2026-10-30T00:00:00Z"))
    const entry: ScheduleEntry = {
      id: "once",
      name: "once",
      runAt: "2026-10-29T23:59:00Z",
      prompt: "test",
      enabled: true,
    }
    const stored: {
      entries: ScheduleEntry[]
      attempt: { firedAt: number; runAt: string } | null
      stopped: Promise<void> | null
    } = { entries: [entry], attempt: null, stopped: null }
    const markFired = vi.fn((_id: string, firedAt: number, runAt: string) => {
      stored.attempt = { firedAt, runAt }
    })
    const removeEntry = vi.fn(() => {
      stored.entries = []
      return true
    })
    const scheduleStore = {
      listEntries: () => stored.entries,
      getLastAttempt: () => stored.attempt,
      markFired,
      removeEntry,
    }
    const connector = new LeucoScheduleConnector({ store: scheduleStore })
    const restarted = new LeucoScheduleConnector({ store: scheduleStore })
    if (phase === "event")
      vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementation(() => {
        throw new Error("synthetic history failure")
      })
    const eventLog = new LeucoEventLog({
      diagnosticOutput: null,
      onFallback: (event) => {
        if (phase === "event" && event.type === "schedule.fired" && stored.stopped === null)
          stored.stopped = connector.stop()
      },
    })
    const runTextTurn = vi.fn(async () => "")
    const context = {
      eventLog,
      runTextTurn,
      onLog: (line: string) => {
        if (phase === "text" && line.includes("firing once") && stored.stopped === null)
          stored.stopped = connector.stop()
      },
    }
    try {
      await connector.start(context)
      await connector.waitForStartupTick()
      await stored.stopped
      expect(stored.stopped).not.toBeNull()
      expect(runTextTurn).not.toHaveBeenCalled()
      expect(markFired).toHaveBeenCalledOnce()
      expect(removeEntry).not.toHaveBeenCalled()
      expect(stored.entries).toEqual([entry])
      await restarted.start(context)
      await restarted.waitForStartupTick()
      expect(runTextTurn).not.toHaveBeenCalled()
      expect(markFired).toHaveBeenCalledOnce()
      expect(removeEntry).toHaveBeenCalledOnce()
      expect(stored.entries).toEqual([])
    } finally {
      await connector.stop()
      await restarted.stop()
      eventLog.close()
    }
  },
)
