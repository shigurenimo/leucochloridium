import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

it.each(["changed-time", "same-instant", "cron-to-one-shot"])(
  "distinguishes a retimed occurrence from the previous attempt after restart: %s",
  async (scenario) => {
    vi.useFakeTimers()
    const now = new Date("2026-05-07T09:30:40Z")
    vi.setSystemTime(now)
    const entry = {
      id: "retimed",
      name: "retimed",
      runAt:
        scenario === "cron-to-one-shot"
          ? `${now.getMinutes()} ${now.getHours()} * * *`
          : "2026-05-07T09:30:00Z",
      prompt: "original request",
      enabled: true,
    }
    const replacement = {
      ...entry,
      runAt: scenario === "same-instant" ? "2026-05-07T18:30:00+09:00" : "2026-05-07T09:30:30Z",
      prompt: "retimed request",
    }
    const store = new MemoryLeucoStore({ schedules: [entry] })
    const build = () => {
      const connector = buildRuntimeConnections({
        settings: store.loadSettings(),
        credentials: null,
        store,
      }).find((connection) => connection instanceof LeucoScheduleConnector)
      if (!(connector instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
      return connector
    }
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const prompts: string[] = []
    const context = {
      eventLog: new LeucoEventLog(),
      onLog: () => {},
      runTextTurn: async (_key: string, text: string) => {
        prompts.push(text)
        started.resolve()
        await finished.promise
        return ""
      },
    }
    const first = build()
    try {
      await first.start(context)
      await started.promise
      store.updateSettings((settings) => ({ ...settings, schedules: [replacement] }))
      finished.resolve()
      await first.waitForStartupTick()
      expect(store.loadSettings().schedules).toEqual([replacement])
    } finally {
      finished.resolve()
      await first.stop()
    }
    vi.setSystemTime(new Date("2026-05-07T09:31:00Z"))
    const second = build()
    try {
      await second.start(context)
      await second.waitForStartupTick()
      expect(prompts).toHaveLength(scenario === "same-instant" ? 1 : 2)
      if (scenario !== "same-instant") expect(prompts[1]).toContain("retimed request")
      expect(store.loadSettings().schedules).toEqual([])
      await second.tickOnce()
      expect(prompts).toHaveLength(scenario === "same-instant" ? 1 : 2)
    } finally {
      await second.stop()
    }
  },
)
