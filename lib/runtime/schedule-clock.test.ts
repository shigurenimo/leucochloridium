import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

it.each([
  "one-shot",
  "cron",
  "cron-catchup",
  "cron-first-catchup",
  "cron-due-at-start-catchup",
  "one-shot-rollback",
  "cron-rollback",
])("uses the current clock after waiting on earlier work: %s", async (scenario) => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
  const rollback = scenario.endsWith("rollback")
  const due = new Date(
    rollback || scenario.includes("due-at-start") ? "2026-05-07T09:30:00Z" : "2026-05-07T09:31:00Z",
  )
  const runAt = scenario.startsWith("cron")
    ? `${due.getMinutes()} ${due.getHours()} * * *`
    : due.toISOString()
  const store = new MemoryLeucoStore({
    schedules: [
      { id: "first", name: "first", runAt: "2026-05-07T09:29:00Z", prompt: "first", enabled: true },
      { id: "second", name: "second", runAt, prompt: "second", enabled: true },
    ],
  })
  if (scenario === "cron-catchup")
    store.updateState((state) => ({
      ...state,
      scheduleLastFiredAt: { second: due.getTime() - 24 * 60 * 60 * 1000 },
    }))
  const connector = buildRuntimeConnections({
    settings: store.loadSettings(),
    credentials: null,
    store,
  }).find((connection) => connection instanceof LeucoScheduleConnector)
  if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
  const started = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const prompts: string[] = []
  await connector.start({
    eventLog: new LeucoEventLog(),
    onLog: () => {},
    runTextTurn: async (_key, text) => {
      prompts.push(text)
      started.resolve()
      await finished.promise
      return ""
    },
  })
  try {
    await started.promise
    const afterWait = new Date(
      rollback
        ? "2026-05-07T09:29:00Z"
        : scenario.includes("catchup")
          ? "2026-05-07T09:32:00Z"
          : "2026-05-07T09:31:00Z",
    )
    vi.setSystemTime(afterWait)
    finished.resolve()
    await connector.waitForStartupTick()
    expect(prompts).toHaveLength(rollback ? 1 : 2)
    if (rollback) {
      expect(store.loadState().scheduleLastFiredAt.second).toBeUndefined()
      vi.setSystemTime(due)
      await connector.tickOnce()
    }
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("second")
    await connector.tickOnce()
    expect(prompts).toHaveLength(2)
  } finally {
    finished.resolve()
    await connector.stop()
  }
})
