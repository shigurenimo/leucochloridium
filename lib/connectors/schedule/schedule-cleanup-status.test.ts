import { afterEach, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ScheduleEntry } from "@/config/config-schema"
import { inspectRuntimeHealth } from "@/runtime/inspect-runtime-health"

afterEach(() => vi.useRealTimers())

it.each(["removed", "disabled", "retimed"])(
  "drops obsolete cleanup retry observations when a schedule is %s",
  async (change) => {
    vi.useFakeTimers()
    const now = Date.parse("2026-05-07T09:30:00Z")
    vi.setSystemTime(now)
    const entry: ScheduleEntry = {
      id: "once",
      name: "once",
      runAt: "2026-05-07T09:00:00Z",
      prompt: "execute once",
      enabled: true,
    }
    const durable: {
      entries: ScheduleEntry[]
      attempt: { firedAt: number; runAt: string } | null
    } = { entries: [entry], attempt: null }
    const events = new LeucoEventLog()
    const turn = vi.fn(async () => "")
    const remove = vi.fn(() => {
      throw new Error("settings unavailable")
    })
    const connector = new LeucoScheduleConnector({
      store: {
        listEntries: () => durable.entries,
        getLastAttempt: () => durable.attempt,
        markFired: (_id, firedAt, runAt) => {
          durable.attempt = { firedAt, runAt }
        },
        removeEntry: remove,
      },
    })
    try {
      await connector.start({
        eventLog: events,
        onLog: () => {},
        runTextTurn: turn,
      })
      await connector.waitForStartupTick()
      expect(connector.getStatus().cleanup).toEqual({ pending: 1, nextRetryAt: now + 60000 })
      const observation = connector.getStatus()
      observation.cleanup.pending = 99
      observation.cleanup.nextRetryAt = 0
      if (observation.lastFailure === null) throw new Error("Missing cleanup failure")
      observation.lastFailure.message = "caller mutation"
      expect(connector.getStatus().cleanup).toEqual({ pending: 1, nextRetryAt: now + 60000 })
      await connector.tickOnce()
      expect(connector.getStatus().lastFailure?.message).toBe("settings unavailable")
      expect(
        inspectRuntimeHealth({
          ready: true,
          runtime: {
            codexRunning: true,
            connections: [{ name: "schedule", type: "schedule", health: connector.getStatus() }],
          },
        }),
      ).toMatchObject({ healthy: false, restartRecommended: false })
      durable.entries =
        change === "removed"
          ? []
          : [
              {
                ...entry,
                enabled: change !== "disabled",
                runAt: change === "retimed" ? "2050-01-01T00:00:00Z" : entry.runAt,
              },
            ]
      vi.setSystemTime(now + 1)
      await connector.tickOnce()
      expect(connector.getStatus().cleanup).toEqual({ pending: 0, nextRetryAt: null })
      expect(connector.getStatus()).toMatchObject({ state: "ready", lastFailure: null })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(turn).toHaveBeenCalledTimes(1)
      expect(durable.attempt).toEqual({ firedAt: now, runAt: entry.runAt })
    } finally {
      await connector.stop()
      events.close()
    }
  },
)

it.each(["removed", "disabled", "retimed"])(
  "refreshes cleanup observations when a schedule is %s during earlier work",
  async (change) => {
    vi.useFakeTimers()
    const now = Date.parse("2026-05-07T09:30:00Z")
    vi.setSystemTime(now)
    const pending: ScheduleEntry = {
      id: "pending",
      name: "pending",
      runAt: "2026-05-07T09:00:00Z",
      prompt: "execute once",
      enabled: true,
    }
    const earlier = { ...pending, id: "earlier", name: "earlier" }
    const durable: { entries: ScheduleEntry[] } = { entries: [pending] }
    const attempts = new Map<string, { firedAt: number; runAt: string }>()
    const started = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    const turns: string[] = []
    const events = new LeucoEventLog()
    const remove = vi.fn((id: string) => {
      if (id === "pending") throw new Error("settings unavailable")
      durable.entries = durable.entries.filter((entry) => entry.id !== id)
      return true
    })
    const connector = new LeucoScheduleConnector({
      store: {
        listEntries: () => durable.entries,
        getLastAttempt: (id) => attempts.get(id) ?? null,
        markFired: (id, firedAt, runAt) => {
          attempts.set(id, { firedAt, runAt })
        },
        removeEntry: remove,
      },
    })
    try {
      await connector.start({
        eventLog: events,
        onLog: () => {},
        runTextTurn: async (key) => {
          turns.push(key)
          if (key === "schedule:earlier") {
            started.resolve()
            await finished.promise
          }
          return ""
        },
      })
      await connector.waitForStartupTick()
      expect(connector.getStatus().cleanup.pending).toBe(1)
      durable.entries = [earlier, pending]
      vi.setSystemTime(now + 1000)
      const tick = connector.tickOnce()
      await started.promise
      durable.entries = [
        earlier,
        ...(change === "removed"
          ? []
          : [
              {
                ...pending,
                enabled: change !== "disabled",
                runAt: change === "retimed" ? "2050-01-01T00:00:00Z" : pending.runAt,
              },
            ]),
      ]
      finished.resolve()
      await tick
      expect(connector.getStatus().cleanup).toEqual({ pending: 0, nextRetryAt: null })
      expect(connector.getStatus()).toMatchObject({ state: "ready", lastFailure: null })
      expect(turns).toEqual(["schedule:pending", "schedule:earlier"])
      expect(remove.mock.calls.map((call) => call[0])).toEqual(["pending", "earlier"])
      expect(attempts.get("pending")).toEqual({ firedAt: now, runAt: pending.runAt })
    } finally {
      finished.resolve()
      await connector.stop()
      events.close()
    }
  },
)
