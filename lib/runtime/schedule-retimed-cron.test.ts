import { afterEach, expect, it, vi } from "vitest"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

it.each(["old-attempt", "old-observation", "restart", "one-shot", "observed-new-expression"])(
  "does not backfill a new cron expression from unrelated previous state: %s",
  async (scenario) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-07T09:00:00Z"))
    const oldDue = new Date(
      scenario === "old-observation" ? "2026-05-07T10:00:00Z" : "2026-05-07T09:00:00Z",
    )
    const newDue = new Date("2026-05-07T09:31:00Z")
    const entry = {
      id: "repeat",
      name: "repeat",
      runAt:
        scenario === "one-shot"
          ? oldDue.toISOString()
          : `${oldDue.getMinutes()} ${oldDue.getHours()} * * *`,
      prompt: "old request",
      enabled: true,
    }
    const replacement = {
      ...entry,
      runAt: `${newDue.getMinutes()} ${newDue.getHours()} * * *`,
      prompt: "new request",
    }
    const store = new MemoryLeucoStore({ schedules: [entry] })
    const build = () => {
      const connection = buildRuntimeConnections({
        settings: store.loadSettings(),
        credentials: null,
        store,
      }).find((connection) => connection instanceof LeucoScheduleConnector)
      if (!(connection instanceof LeucoScheduleConnector)) throw new Error("schedule missing")
      return connection
    }
    const turn = vi.fn(async () => "")
    const context = {
      eventLog: new LeucoEventLog(),
      onLog: () => {},
      runTextTurn: turn,
    }
    const current = { connector: build() }
    try {
      await current.connector.start(context)
      await current.connector.waitForStartupTick()
      const initial = scenario === "old-observation" ? 0 : 1
      expect(turn).toHaveBeenCalledTimes(initial)
      if (scenario === "restart") await current.connector.stop()
      vi.setSystemTime(
        new Date(
          scenario === "observed-new-expression" ? "2026-05-07T09:30:00Z" : "2026-05-07T09:32:00Z",
        ),
      )
      store.updateSettings((settings) => ({ ...settings, schedules: [replacement] }))
      if (scenario === "restart") {
        current.connector = build()
        await current.connector.start(context)
        await current.connector.waitForStartupTick()
      } else await current.connector.tickOnce()
      expect(turn).toHaveBeenCalledTimes(initial)
      vi.setSystemTime(
        new Date(
          scenario === "observed-new-expression" ? "2026-05-07T09:32:00Z" : "2026-05-08T09:31:00Z",
        ),
      )
      await current.connector.tickOnce()
      expect(turn).toHaveBeenCalledTimes(initial + 1)
      expect(turn.mock.calls.at(-1)).toEqual(
        expect.arrayContaining([expect.stringContaining("new request")]),
      )
      await current.connector.tickOnce()
      expect(turn).toHaveBeenCalledTimes(initial + 1)
    } finally {
      await current.connector.stop()
    }
  },
)
