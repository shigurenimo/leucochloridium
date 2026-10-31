import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"

afterEach(() => vi.useRealTimers())

it("bounds settings reads for a large idle schedule list", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
  const store = new MemoryLeucoStore({
    schedules: Array.from({ length: 1000 }, (_, index) => ({
      id: String(index),
      name: `future-${index}`,
      runAt: "2050-01-01T00:00:00Z",
      prompt: "future request",
      enabled: true,
    })),
  })
  const connector = buildRuntimeConnections({
    settings: store.loadSettings(),
    credentials: null,
    store,
  }).find((connection) => connection instanceof LeucoScheduleConnector)
  if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
  const reads = vi.spyOn(store, "loadSettings")
  const turn = vi.fn(async () => "")
  try {
    await connector.start({
      eventLog: new LeucoEventLog(),
      onLog: () => {},
      runTextTurn: turn,
    })
    await connector.waitForStartupTick()
    expect(reads.mock.calls.length).toBeLessThanOrEqual(2)
    expect(turn).not.toHaveBeenCalled()
  } finally {
    await connector.stop()
  }
})

for (const runAt of ["2026-05-07T09:29:00Z", "* * * * *"]) {
  it.each([
    "removed",
    "disabled",
    "retimed",
    "edited",
    "disabled-after-failure",
    "edited-after-failure",
  ])(`refreshes a waiting ${runAt} schedule after earlier work completes: %s`, async (scenario) => {
    const change = scenario.replace("-after-failure", "")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
    const first: ScheduleEntry = {
      id: "first",
      name: "first",
      runAt: "2026-05-07T09:29:00Z",
      prompt: "first request",
      enabled: true,
    }
    const second = { ...first, id: "second", name: "second", runAt, prompt: "old request" }
    const replacement = {
      ...second,
      enabled: change !== "disabled",
      runAt: change === "retimed" ? "2026-05-07T10:00:00Z" : runAt,
      prompt: "updated request",
    }
    const store = new MemoryLeucoStore({ schedules: [first, second] })
    const connector = buildRuntimeConnections({
      settings: store.loadSettings(),
      credentials: null,
      store,
    }).find((connection) => connection instanceof LeucoScheduleConnector)
    if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const prompts: string[] = []
    const eventLog = new LeucoEventLog()
    await connector.start({
      eventLog,
      onLog: () => {},
      runTextTurn: async (_threadKey, text) => {
        prompts.push(text)
        started.resolve()
        await finished.promise
        return scenario.endsWith("-after-failure") && prompts.length === 1
          ? new Error("first turn failed")
          : ""
      },
    })
    try {
      await started.promise
      store.updateSettings((settings) => ({
        ...settings,
        schedules: change === "removed" ? [] : [replacement],
      }))
      finished.resolve()
      await connector.waitForStartupTick()
      expect(prompts).toHaveLength(change === "edited" ? 2 : 1)
      if (change === "edited") expect(prompts[1]).toContain("updated request")
      else {
        expect(store.loadState().scheduleLastFiredAt.second).toBeUndefined()
        expect(eventLog.query().filter((row) => row.event.type === "schedule.fired")).toHaveLength(
          1,
        )
        expect(store.loadSettings().schedules).toEqual(change === "removed" ? [] : [replacement])
      }
    } finally {
      finished.resolve()
      await connector.stop()
    }
  })
}
