import { afterEach, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"

afterEach(() => vi.useRealTimers())

it("rejects duplicate starts without leaving an interval after stop", async () => {
  vi.useFakeTimers()
  const eventLog = new LeucoEventLog()
  const listEntries = vi.fn(() => [])
  const connector = new LeucoScheduleConnector({
    store: {
      listEntries,
      removeEntry: () => false,
      getLastAttempt: () => null,
      markFired: () => {},
    },
  })
  const context = {
    eventLog,
    onLog: () => {},
    runTextTurn: async () => "",
  }
  try {
    await connector.start(context)
    await connector.waitForStartupTick()
    await expect(connector.start(context)).rejects.toThrow("already started or stopping")
    expect(listEntries).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    await connector.stop()
    eventLog.close()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it("requires a held tick to finish stopping before the next start", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse("2026-10-30T00:00:00Z"))
  const eventLog = new LeucoEventLog()
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<string>()
  const current: { entries: ScheduleEntry[] } = {
    entries: [
      {
        id: "once",
        name: "once",
        runAt: "2026-10-29T23:59:00Z",
        prompt: "test",
        enabled: true,
      },
    ],
  }
  const connector = new LeucoScheduleConnector({
    store: {
      listEntries: () => current.entries,
      removeEntry: () => false,
      getLastAttempt: () => null,
      markFired: () => {},
    },
  })
  const context = {
    eventLog,
    onLog: () => {},
    runTextTurn: () => {
      entered.resolve()
      return finish.promise
    },
  }
  try {
    await connector.start(context)
    await entered.promise
    const stopping = connector.stop()
    await expect(connector.start(context)).rejects.toThrow("already started or stopping")
    expect(vi.getTimerCount()).toBe(0)
    finish.resolve("")
    await stopping
    current.entries = []
    await connector.start(context)
    await connector.waitForStartupTick()
    expect(connector.getStatus().state).toBe("ready")
    expect(vi.getTimerCount()).toBe(1)
  } finally {
    finish.resolve("")
    await connector.stop()
    eventLog.close()
  }
  expect(vi.getTimerCount()).toBe(0)
})

it.each(["ready", "first tick"])(
  "does not leave a timer when the %s diagnostic callback stops startup",
  async (phase) => {
    vi.useFakeTimers()
    const eventLog = new LeucoEventLog()
    const stopped: { promise: Promise<void> | null } = { promise: null }
    const connector = new LeucoScheduleConnector({
      store: {
        listEntries: () => {
          if (phase === "first tick") throw new Error("synthetic settings read failure")
          return []
        },
        removeEntry: () => false,
        getLastAttempt: () => null,
        markFired: () => {},
      },
    })
    try {
      const started = await connector
        .start({
          eventLog,
          onLog: (line) => {
            if (
              (phase === "ready" && line.includes("schedule connector ready")) ||
              (phase === "first tick" && line.includes("failed to read entries"))
            )
              stopped.promise = connector.stop()
          },
          runTextTurn: async () => "",
        })
        .catch((error: unknown) => error)
      await stopped.promise
      expect(vi.getTimerCount()).toBe(0)
      expect(started).toBeInstanceOf(Error)
    } finally {
      await connector.stop()
      eventLog.close()
    }
  },
)

it("does not overlap a tick requested synchronously from its failure diagnostic", async () => {
  vi.useFakeTimers()
  const eventLog = new LeucoEventLog()
  const listEntries = vi.fn(() => {
    throw new Error("synthetic settings read failure")
  })
  const connector = new LeucoScheduleConnector({
    store: {
      listEntries,
      removeEntry: () => false,
      getLastAttempt: () => null,
      markFired: () => {},
    },
  })
  const observed = { requested: false }
  try {
    await connector.start({
      eventLog,
      onLog: (line) => {
        if (!observed.requested && line.includes("failed to read entries")) {
          observed.requested = true
          void connector.tickOnce()
        }
      },
      runTextTurn: async () => "",
    })
    await connector.waitForStartupTick()
    expect(observed.requested).toBe(true)
    expect(listEntries).toHaveBeenCalledOnce()
  } finally {
    await connector.stop()
    eventLog.close()
  }
})
