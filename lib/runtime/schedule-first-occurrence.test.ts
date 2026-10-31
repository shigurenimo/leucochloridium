import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

it.each(["live", "new-id", "restart"])(
  "handles a never-fired cron across a skipped timer tick: %s",
  async (scenario) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
    const due = new Date("2026-05-07T09:31:00Z")
    const entry = {
      id: "first-time",
      name: "first-time",
      runAt: `${due.getMinutes()} ${due.getHours()} * * *`,
      prompt: "first occurrence",
      enabled: true,
    }
    const store = new MemoryLeucoStore({ schedules: scenario === "new-id" ? [] : [entry] })
    const connector = buildRuntimeConnections({
      settings: store.loadSettings(),
      credentials: null,
      store,
    }).find((connection) => connection instanceof LeucoScheduleConnector)
    if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
    const turn = vi.fn(async () => "")
    const context = {
      eventLog: new LeucoEventLog(),
      onLog: () => {},
      runTextTurn: turn,
    }
    await connector.start(context)
    try {
      await connector.waitForStartupTick()
      expect(turn).not.toHaveBeenCalled()
      expect(store.loadState().scheduleLastFiredAt[entry.id]).toBeUndefined()
      if (scenario === "restart") await connector.stop()
      vi.setSystemTime(new Date("2026-05-07T09:32:00Z"))
      if (scenario === "new-id")
        store.updateSettings((settings) => ({ ...settings, schedules: [entry] }))
      if (scenario === "restart") {
        await connector.start(context)
        await connector.waitForStartupTick()
      } else await connector.tickOnce()
      expect(turn).toHaveBeenCalledTimes(scenario === "live" ? 1 : 0)
      await connector.tickOnce()
      expect(turn).toHaveBeenCalledTimes(scenario === "live" ? 1 : 0)
      if (scenario === "live") {
        expect(store.loadState().scheduleLastFiredAt[entry.id]).toBe(Date.now())
        vi.setSystemTime(new Date("2026-05-08T09:32:00Z"))
        await connector.tickOnce()
        expect(turn).toHaveBeenCalledTimes(2)
      }
    } finally {
      await connector.stop()
    }
  },
)
