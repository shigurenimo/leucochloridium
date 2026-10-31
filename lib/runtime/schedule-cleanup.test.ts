import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"

afterEach(() => vi.useRealTimers())

it.each(["2026-05-07T09:32:00Z", "* * * * *"])(
  "preserves a rescheduled entry changed inside the cleanup transaction: %s",
  async (runAt) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-07T09:30:00Z"))
    const entry: ScheduleEntry = {
      id: "22222222-2222-4222-8222-222222222222",
      name: "checkin",
      runAt: "2026-05-07T09:29:00Z",
      prompt: "old request",
      enabled: true,
    }
    const replacement = { ...entry, runAt, prompt: "rescheduled request" }
    const store = new MemoryLeucoStore({ schedules: [entry] })
    const connector = buildRuntimeConnections({
      settings: store.loadSettings(),
      credentials: null,
      store,
    }).find((connection) => connection instanceof LeucoScheduleConnector)
    if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const prompts: string[] = []
    const logs: string[] = []
    await connector.start({
      eventLog: new LeucoEventLog(),
      onLog: (line) => logs.push(line),
      runTextTurn: async (_threadKey, text) => {
        prompts.push(text)
        started.resolve()
        await finished.promise
        return ""
      },
    })
    try {
      await started.promise
      const updateSettings = store.updateSettings.bind(store)
      vi.spyOn(store, "updateSettings").mockImplementationOnce((transform) => {
        // Another writer commits after cleanup begins, before its locked fresh read.
        updateSettings((settings) => ({ ...settings, schedules: [replacement] }))
        updateSettings(transform)
      })
      finished.resolve()
      await connector.waitForStartupTick()
      expect(store.loadSettings().schedules).toEqual([replacement])
      expect(logs.some((line) => line.includes("cleanup skipped"))).toBe(true)
      expect(logs.some((line) => line.includes("removed after recorded attempt"))).toBe(false)
      vi.setSystemTime(new Date("2026-05-07T09:32:00Z"))
      await connector.tickOnce()
      expect(prompts).toHaveLength(2)
      expect(prompts[1]).toContain("rescheduled request")
      expect(store.loadSettings().schedules).toEqual(runAt.includes("*") ? [replacement] : [])
    } finally {
      finished.resolve()
      await connector.stop()
    }
  },
)
