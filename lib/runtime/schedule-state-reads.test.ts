import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

it("reads durable attempts once per idle cron tick rather than twice per schedule", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
  const store = new MemoryLeucoStore({
    schedules: Array.from({ length: 1000 }, (_, index) => ({
      id: String(index),
      name: `future-${index}`,
      runAt: "0 0 1 1 *",
      prompt: "future request",
      enabled: true,
    })),
  })
  store.updateState((state) => ({
    ...state,
    scheduleLastFiredAt: Object.fromEntries(
      Array.from({ length: 1000 }, (_, index) => [
        String(index),
        Date.parse("2025-01-01T00:00:00Z"),
      ]),
    ),
  }))
  const connector = buildRuntimeConnections({
    settings: store.loadSettings(),
    credentials: null,
    store,
  }).find((connection) => connection instanceof LeucoScheduleConnector)
  if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
  const reads = vi.spyOn(store, "loadState")
  const events = new LeucoEventLog()
  const turn = vi.fn(async () => "")
  try {
    await connector.start({
      eventLog: events,
      onLog: () => {},
      runTextTurn: turn,
    })
    await connector.waitForStartupTick()
    expect(reads).toHaveBeenCalledTimes(1)
    reads.mockClear()
    await connector.tickOnce()
    expect(reads).toHaveBeenCalledTimes(1)
    expect(turn).not.toHaveBeenCalled()
  } finally {
    await connector.stop()
    events.close()
  }
})

it("refreshes durable attempts between ticks and after waiting for a preceding turn", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
  const store = new MemoryLeucoStore({
    schedules: ["first", "second"].map((id) => ({
      id,
      name: id,
      runAt: "* * * * *",
      prompt: id,
      enabled: true,
    })),
  })
  const connector = buildRuntimeConnections({
    settings: store.loadSettings(),
    credentials: null,
    store,
  }).find((connection) => connection instanceof LeucoScheduleConnector)
  if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
  const events = new LeucoEventLog()
  const turns: string[] = []
  try {
    await connector.start({
      eventLog: events,
      onLog: () => {},
      runTextTurn: async (key) => {
        turns.push(key)
        store.updateState((state) => ({
          ...state,
          scheduleLastFiredAt: { ...state.scheduleLastFiredAt, second: Date.now() },
          scheduleLastRunAt: { ...state.scheduleLastRunAt, second: "* * * * *" },
        }))
        return ""
      },
    })
    await connector.waitForStartupTick()
    expect(turns).toEqual(["schedule:first"])
    vi.setSystemTime(new Date("2026-05-07T09:31:00Z"))
    store.updateState((state) => ({
      ...state,
      scheduleLastFiredAt: { ...state.scheduleLastFiredAt, first: Date.now(), second: Date.now() },
    }))
    await connector.tickOnce()
    expect(turns).toHaveLength(1)
  } finally {
    await connector.stop()
    events.close()
  }
})
