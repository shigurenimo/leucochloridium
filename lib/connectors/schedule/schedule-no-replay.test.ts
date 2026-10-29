import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"
import type { ConnectorContext } from "@/connectors/connector"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("one-shot safety after uncertain execution", () => {
  it("persists the decision before dispatch and does not replay failed work after restart", async () => {
    const entry: ScheduleEntry = {
      id: "once",
      name: "charge",
      runAt: "2026-10-01T00:00:00Z",
      prompt: "charge once",
      enabled: true,
    }
    const durable: { timestamp: number | null; entries: ScheduleEntry[] } = {
      timestamp: null,
      entries: [entry],
    }
    const observed: Array<number | null> = []
    const context: ConnectorContext = {
      cwd: "/work",
      runtimeName: "leuco",
      onLog: () => {},
      eventLog: new LeucoEventLog(),
      runTextTurn: async () => {
        observed.push(durable.timestamp)
        return new Error("Result unknown after external write")
      },
    }
    const connector = () =>
      new LeucoScheduleConnector({
        name: "schedule",
        now: () => new Date("2026-10-02T00:00:00Z"),
        store: {
          listEntries: () => durable.entries,
          getLastFiredAt: () => durable.timestamp,
          markFired: (_id, timestamp) => {
            durable.timestamp = timestamp
          },
          removeEntry: () => {
            durable.entries = []
          },
        },
      })
    const first = connector()
    await first.start(context)
    await first.waitForStartupTick()
    await first.stop()
    const second = connector()
    await second.start(context)
    await second.waitForStartupTick()
    await second.stop()
    expect(observed).toHaveLength(1)
    expect(observed[0]).not.toBeNull()
  })
})
