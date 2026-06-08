import { describe, expect, it } from "vitest"
import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import type { ScheduleEntry } from "@/config/config-schema"
import type { ChannelPluginContext } from "@/engine/channel-plugin"
import { LeucoEventBus } from "@/events/leuco-event-bus"

type Captured = {
  turns: { threadKey: string; text: string }[]
  logs: string[]
  bus: LeucoEventBus
  events: { type: string }[]
}

const makeCtx = (): { ctx: ChannelPluginContext; captured: Captured } => {
  const captured: Captured = { turns: [], logs: [], bus: new LeucoEventBus(), events: [] }
  captured.bus.subscribe((event) => {
    captured.events.push(event)
  })

  const ctx: ChannelPluginContext = {
    cwd: "/tmp/demo",
    onLog: (line) => captured.logs.push(line),
    runTextTurn: async (threadKey, text) => {
      captured.turns.push({ threadKey, text })
      return ""
    },
    bus: captured.bus,
    projectName: "demo",
  }
  return { ctx, captured }
}

const makeStore = (
  entries: ScheduleEntry[],
): ScheduleStorePort & {
  entries: ScheduleEntry[]
  lastFiredAt: Record<string, number>
} => {
  const store = {
    entries,
    lastFiredAt: {} as Record<string, number>,
    listEntries() {
      return store.entries
    },
    removeEntry(entryId: string) {
      const before = store.entries.length
      store.entries = store.entries.filter((e) => e.id !== entryId)
      if (store.entries.length === before) throw new Error(`not found: ${entryId}`)
    },
    getLastFiredAt(entryId: string): number | null {
      return store.lastFiredAt[entryId] ?? null
    },
    markFired(entryId: string, firedAt: number): void {
      store.lastFiredAt[entryId] = firedAt
    },
  }
  return store
}

const buildPlugin = (store: ScheduleStorePort, fixedNow: Date): LeucoScheduleChannelPlugin => {
  return new LeucoScheduleChannelPlugin({
    name: "cron",
    store,
    now: () => fixedNow,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  })
}

const cronEntry = (overrides: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "every-minute",
  runAt: "* * * * *",
  prompt: "ping",
  enabled: true,
  ...overrides,
})

const isoEntry = (overrides: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "future-checkin",
  runAt: "2026-05-07T09:00:00Z",
  prompt: "morning checkin",
  enabled: true,
  ...overrides,
})

describe("LeucoScheduleChannelPlugin", () => {
  it("fires a cron entry when its expression matches the current minute", async () => {
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 30))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toHaveLength(1)
    expect(captured.turns[0]!.threadKey).toBe("schedule:11111111-1111-4111-8111-111111111111")
    expect(captured.turns[0]!.text).toContain("ping")
    expect(captured.events.some((e) => e.type === "schedule.fired")).toBe(true)
  })

  it("does not fire a cron entry whose expression does not match", async () => {
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 31))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toEqual([])
  })

  it("does not double-fire a cron entry within the same minute", async () => {
    const store = makeStore([cronEntry()])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 30, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.tickOnce()
    await plugin.tickOnce()

    expect(captured.turns).toHaveLength(1)
  })

  it("fires a one-shot entry when runAt is past and removes it", async () => {
    const store = makeStore([isoEntry({ runAt: "2026-05-07T09:00:00Z" })])
    const plugin = buildPlugin(store, new Date("2026-05-07T09:01:00Z"))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toHaveLength(1)
    expect(store.entries).toEqual([])
  })

  it("does not fire a one-shot whose runAt is still in the future", async () => {
    const store = makeStore([isoEntry({ runAt: "2026-05-07T10:00:00Z" })])
    const plugin = buildPlugin(store, new Date("2026-05-07T09:00:00Z"))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toEqual([])
    expect(store.entries).toHaveLength(1)
  })

  it("skips disabled entries", async () => {
    const store = makeStore([cronEntry({ enabled: false })])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 30))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toEqual([])
  })

  it("logs and skips entries with malformed cron", async () => {
    const store = makeStore([cronEntry({ runAt: "not a cron" })])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 30))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toEqual([])
    expect(captured.logs.some((l) => l.includes("bad cron"))).toBe(true)
  })

  it("forgets lastFiredMinute keys for entries removed from the store", async () => {
    const oneShot = isoEntry({
      id: "33333333-3333-4333-8333-333333333333",
      runAt: "2026-05-07T08:59:00Z",
    })
    const store = makeStore([oneShot])
    const plugin = buildPlugin(store, new Date("2026-05-07T09:00:00Z"))

    const { ctx } = makeCtx()
    await plugin.start(ctx)

    expect(store.entries).toEqual([])
    const tracked = (plugin as unknown as { lastFiredMinute: Map<string, number> }).lastFiredMinute
    expect(tracked.has(oneShot.id)).toBe(true)

    await plugin.tickOnce()
    expect(tracked.has(oneShot.id)).toBe(false)
  })

  it("continues processing other entries after one fails", async () => {
    const store = makeStore([
      cronEntry({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "fails", runAt: "* * * * *" }),
      cronEntry({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "ok", runAt: "* * * * *" }),
    ])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 30))

    const { ctx: baseCtx, captured } = makeCtx()
    let calls = 0
    const ctx: ChannelPluginContext = {
      ...baseCtx,
      runTextTurn: async (threadKey, text) => {
        calls++
        if (calls === 1) return new Error("boom")
        captured.turns.push({ threadKey, text })
        return ""
      },
    }

    await plugin.start(ctx)

    expect(calls).toBe(2)
    expect(captured.turns).toHaveLength(1)
  })

  it("catches up a cron fire that was missed during daemon downtime", async () => {
    // Entry fires every day at 09:30. Last actual fire two days ago; daemon
    // now wakes up at 12:00 on day three — a 09:30 catch-up should land.
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    store.lastFiredAt[store.entries[0]!.id] = new Date(2026, 4, 5, 9, 30).getTime()
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 12, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toHaveLength(1)
    expect(captured.turns[0]!.text).toContain("ping")
    expect(store.lastFiredAt[store.entries[0]!.id]).toBeGreaterThan(
      new Date(2026, 4, 5, 9, 30).getTime(),
    )
  })

  it("does not catch up entries that have never fired", async () => {
    // No `lastFiredAt` → the plugin treats this as a fresh agent and only
    // fires on the current minute. Catch-up requires a prior baseline.
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 12, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toEqual([])
  })

  it("caps catch-up lookback to 24 hours", async () => {
    // lastFiredAt is a week ago; only the matches within the 24h window
    // count. With `30 9 * * *` there is exactly one such minute, so one
    // catch-up fires (not seven).
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    store.lastFiredAt[store.entries[0]!.id] = new Date(2026, 3, 30, 9, 30).getTime()
    const plugin = buildPlugin(store, new Date(2026, 4, 7, 12, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)

    expect(captured.turns).toHaveLength(1)
  })
})
