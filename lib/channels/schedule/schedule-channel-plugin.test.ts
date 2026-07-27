import { describe, expect, it } from "vitest"
import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import type { ScheduleEntry } from "@/config/config-schema"
import type { ChannelPluginContext } from "@/channels/channel-plugin"
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

const buildPlugin = (
  store: ScheduleStorePort,
  clock: Date | (() => Date),
): LeucoScheduleChannelPlugin => {
  const now = typeof clock === "function" ? clock : () => clock
  return new LeucoScheduleChannelPlugin({
    name: "cron",
    store,
    now,
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
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 9, 30))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toHaveLength(1)
    expect(captured.turns[0]!.threadKey).toBe("schedule:11111111-1111-4111-8111-111111111111")
    expect(captured.turns[0]!.text).toContain("ping")
    expect(captured.events.some((e) => e.type === "schedule.fired")).toBe(true)
  })

  it("does not fire a cron entry whose expression does not match", async () => {
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 9, 31))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toEqual([])
  })

  it("does not double-fire a cron entry within the same minute", async () => {
    const store = makeStore([cronEntry()])
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 9, 30, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()
    await plugin.tickOnce()
    await plugin.tickOnce()

    expect(captured.turns).toHaveLength(1)
  })

  it("fires a one-shot entry when runAt is past and removes it", async () => {
    const entry = isoEntry({ runAt: "2026-05-07T09:00:00Z" })
    const store = makeStore([entry])
    const plugin = buildPlugin(store, new Date("2026-05-07T09:01:00Z"))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toHaveLength(1)
    expect(store.lastFiredAt[entry.id]).toBe(new Date("2026-05-07T09:01:00Z").getTime())
    expect(store.entries).toEqual([])
  })

  it("does not fire a one-shot whose runAt is still in the future", async () => {
    const store = makeStore([isoEntry({ runAt: "2026-05-07T10:00:00Z" })])
    const plugin = buildPlugin(store, () => new Date("2026-05-07T09:00:00Z"))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toEqual([])
    expect(store.entries).toHaveLength(1)
  })

  it("skips disabled entries", async () => {
    const store = makeStore([cronEntry({ enabled: false })])
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 9, 30))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toEqual([])
  })

  it("logs and skips entries with malformed cron", async () => {
    const store = makeStore([cronEntry({ runAt: "not a cron" })])
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 9, 30))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toEqual([])
    expect(captured.logs.some((l) => l.includes("bad cron"))).toBe(true)
  })

  it("forgets lastFiredMinute keys for entries removed from the store", async () => {
    const oneShot = isoEntry({
      id: "33333333-3333-4333-8333-333333333333",
      runAt: "2026-05-07T08:59:00Z",
    })
    const store = makeStore([oneShot])
    const plugin = buildPlugin(store, () => new Date("2026-05-07T09:00:00Z"))

    const { ctx } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

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
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 9, 30))

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
    await plugin.waitForStartupTick()

    expect(calls).toBe(2)
    expect(captured.turns).toHaveLength(1)
  })

  it("catches up a cron fire that was missed during daemon downtime", async () => {
    // Entry fires every day at 09:30. Last actual fire two days ago; daemon
    // now wakes up at 12:00 on day three — a 09:30 catch-up should land.
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    store.lastFiredAt[store.entries[0]!.id] = new Date(2026, 4, 5, 9, 30).getTime()
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 12, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toHaveLength(1)
    expect(captured.turns[0]!.text).toContain("ping")
    expect(store.lastFiredAt[store.entries[0]!.id]).toBeGreaterThan(
      new Date(2026, 4, 5, 9, 30).getTime(),
    )
  })

  it("does not catch up entries that have never fired", async () => {
    // No `lastFiredAt` and no evaluated pass yet → the plugin treats this as
    // a fresh agent and only evaluates the current minute on its first pass.
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 12, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toEqual([])
  })

  it("caps catch-up lookback to 24 hours", async () => {
    // lastFiredAt is a week ago; only the matches within the 24h window
    // count. With `30 9 * * *` there is exactly one such minute, so one
    // catch-up fires (not seven).
    const store = makeStore([cronEntry({ runAt: "30 9 * * *" })])
    store.lastFiredAt[store.entries[0]!.id] = new Date(2026, 3, 30, 9, 30).getTime()
    const plugin = buildPlugin(store, () => new Date(2026, 4, 7, 12, 0))

    const { ctx, captured } = makeCtx()
    await plugin.start(ctx)
    await plugin.waitForStartupTick()

    expect(captured.turns).toHaveLength(1)
  })
})

describe("LeucoScheduleChannelPlugin lifecycle isolation", () => {
  it("drains the current one-shot and leaves later entries for the replacement", async () => {
    const firstEntry = isoEntry({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "first",
    })
    const secondEntry = isoEntry({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: "second",
    })
    const now = new Date("2026-05-07T09:01:00Z")
    const store = makeStore([firstEntry, secondEntry])
    const plugin = buildPlugin(store, now)
    const current = makeCtx()
    let releaseTurn: () => void = () => {}
    let reportTurnStarted: () => void = () => {}
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const turnStarted = new Promise<void>((resolve) => {
      reportTurnStarted = resolve
    })
    current.ctx.runTextTurn = async (threadKey, text) => {
      current.captured.turns.push({ threadKey, text })
      reportTurnStarted()
      await turnGate
      return ""
    }

    await plugin.start(current.ctx)
    await turnStarted
    let isStopped = false
    const stopping = plugin.stop().then(() => {
      isStopped = true
    })
    await Promise.resolve()

    expect(isStopped).toBe(false)
    releaseTurn()
    await stopping

    expect(current.captured.turns.map((turn) => turn.threadKey)).toEqual([
      `schedule:${firstEntry.id}`,
    ])
    expect(store.entries).toEqual([secondEntry])
    await plugin.tickOnce()
    expect(current.captured.turns).toHaveLength(1)

    const replacement = buildPlugin(store, now)
    const next = makeCtx()
    await replacement.start(next.ctx)
    await replacement.waitForStartupTick()

    expect(next.captured.turns.map((turn) => turn.threadKey)).toEqual([
      `schedule:${secondEntry.id}`,
    ])
    expect(store.entries).toEqual([])
    await replacement.stop()
  })

  it("persists a drained cron fire so replacement in the same minute does not duplicate it", async () => {
    const entry = cronEntry()
    const now = new Date(2026, 4, 7, 9, 30)
    const store = makeStore([entry])
    const plugin = buildPlugin(store, now)
    const current = makeCtx()
    let releaseTurn: () => void = () => {}
    let reportTurnStarted: () => void = () => {}
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const turnStarted = new Promise<void>((resolve) => {
      reportTurnStarted = resolve
    })
    current.ctx.runTextTurn = async (threadKey, text) => {
      current.captured.turns.push({ threadKey, text })
      reportTurnStarted()
      await turnGate
      return ""
    }

    await plugin.start(current.ctx)
    await turnStarted
    const stopping = plugin.stop()
    releaseTurn()
    await stopping

    expect(store.lastFiredAt[entry.id]).toBe(now.getTime())

    const replacement = buildPlugin(store, now)
    const next = makeCtx()
    await replacement.start(next.ctx)
    await replacement.waitForStartupTick()

    expect(current.captured.turns).toHaveLength(1)
    expect(next.captured.turns).toEqual([])
    await replacement.stop()
  })
})

describe("LeucoScheduleChannelPlugin failure containment", () => {
  it("retains a failed one-shot and retries with exponential backoff until success", async () => {
    const entry = isoEntry()
    const store = makeStore([entry])
    const clock = { nowMs: new Date("2026-05-07T09:01:00Z").getTime() }
    const plugin = new LeucoScheduleChannelPlugin({
      name: "cron",
      store,
      now: () => new Date(clock.nowMs),
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    })
    const results = [new Error("codex down"), new Error("still down"), "ok"]
    const { ctx, captured } = makeCtx()
    ctx.runTextTurn = async (threadKey, text) => {
      captured.turns.push({ threadKey, text })
      return results[captured.turns.length - 1] ?? "ok"
    }

    await plugin.start(ctx)
    await plugin.waitForStartupTick()
    expect(captured.turns).toHaveLength(1)
    expect(store.entries).toEqual([entry])

    clock.nowMs += 59_000
    await plugin.tickOnce()
    expect(captured.turns).toHaveLength(1)

    clock.nowMs += 1_000
    await plugin.tickOnce()
    expect(captured.turns).toHaveLength(2)
    expect(store.entries).toEqual([entry])

    clock.nowMs += 119_000
    await plugin.tickOnce()
    expect(captured.turns).toHaveLength(2)

    clock.nowMs += 1_000
    await plugin.tickOnce()
    expect(captured.turns).toHaveLength(3)
    expect(store.lastFiredAt[entry.id]).toBe(clock.nowMs)
    expect(store.entries).toEqual([])
    expect(captured.logs.some((line) => line.includes("turn failed: codex down"))).toBe(true)
    expect(captured.logs.some((line) => line.includes("turn retry #1 in 60s"))).toBe(true)
    expect(captured.logs.some((line) => line.includes("turn retry #2 in 120s"))).toBe(true)
  })

  it("caps one-shot retry delay at thirty minutes", async () => {
    const entry = isoEntry()
    const store = makeStore([entry])
    const clock = { nowMs: new Date("2026-05-07T09:01:00Z").getTime() }
    const plugin = new LeucoScheduleChannelPlugin({
      name: "cron",
      store,
      now: () => new Date(clock.nowMs),
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    })
    const { ctx, captured } = makeCtx()
    ctx.runTextTurn = async (threadKey, text) => {
      captured.turns.push({ threadKey, text })
      return new Error("codex down")
    }

    await plugin.start(ctx)
    await plugin.waitForStartupTick()
    const delays = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]
    for (const delayMs of delays) {
      clock.nowMs += delayMs
      await plugin.tickOnce()
    }

    const retryLogs = captured.logs.filter((line) => line.includes("turn retry"))
    expect(captured.turns).toHaveLength(8)
    expect(retryLogs).toEqual([
      expect.stringContaining("retry #1 in 60s"),
      expect.stringContaining("retry #2 in 120s"),
      expect.stringContaining("retry #3 in 240s"),
      expect.stringContaining("retry #4 in 480s"),
      expect.stringContaining("retry #5 in 960s"),
      expect.stringContaining("retry #6 in 1800s"),
      expect.stringContaining("retry #6 in 1800s"),
      expect.stringContaining("retry #6 in 1800s"),
    ])
  })

  it("retries deletion without re-running a successfully delivered one-shot", async () => {
    const entry = isoEntry()
    const store = makeStore([entry])
    const removeEntry = store.removeEntry
    const removal = { calls: 0 }
    store.removeEntry = (entryId) => {
      removal.calls++
      if (removal.calls === 1) throw new Error("settings busy")
      removeEntry(entryId)
    }
    const clock = { nowMs: new Date("2026-05-07T09:01:00Z").getTime() }
    const plugin = new LeucoScheduleChannelPlugin({
      name: "cron",
      store,
      now: () => new Date(clock.nowMs),
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    })
    const { ctx, captured } = makeCtx()

    await plugin.start(ctx)
    await plugin.waitForStartupTick()
    expect(captured.turns).toHaveLength(1)
    expect(store.entries).toEqual([entry])

    clock.nowMs += 60_000
    await plugin.tickOnce()

    expect(captured.turns).toHaveLength(1)
    expect(removal.calls).toBe(2)
    expect(store.entries).toEqual([])
    expect(captured.logs.some((line) => line.includes("cleanup retry #1 in 60s"))).toBe(true)
    expect(captured.logs.some((line) => line.includes("delete failed: settings busy"))).toBe(true)
  })

  it("uses the durable delivery marker to avoid re-running after restart", async () => {
    const entry = isoEntry()
    const store = makeStore([entry])
    const removeEntry = store.removeEntry
    const removal = { calls: 0 }
    store.removeEntry = (entryId) => {
      removal.calls++
      if (removal.calls === 1) throw new Error("settings busy")
      removeEntry(entryId)
    }
    const now = new Date("2026-05-07T09:01:00Z")
    const firstPlugin = buildPlugin(store, now)
    const first = makeCtx()

    await firstPlugin.start(first.ctx)
    await firstPlugin.waitForStartupTick()
    await firstPlugin.stop()

    expect(first.captured.turns).toHaveLength(1)
    expect(store.lastFiredAt[entry.id]).toBe(now.getTime())
    expect(store.entries).toEqual([entry])

    const restartedPlugin = buildPlugin(store, now)
    const restarted = makeCtx()
    await restartedPlugin.start(restarted.ctx)
    await restartedPlugin.waitForStartupTick()

    expect(restarted.captured.turns).toEqual([])
    expect(store.entries).toEqual([])
    expect(
      restarted.captured.logs.some((line) => line.includes("already delivered; retrying cleanup")),
    ).toBe(true)
  })

  it("retries a failed cron turn once via catch-up, then stops until restart", async () => {
    const entry = cronEntry({ runAt: "30 9 * * *" })
    const store = makeStore([entry])
    store.lastFiredAt[entry.id] = new Date(2026, 4, 6, 10, 0).getTime()

    let now = new Date(2026, 4, 7, 9, 30)
    const plugin = new LeucoScheduleChannelPlugin({
      name: "cron",
      store,
      now: () => now,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    })

    const { ctx, captured } = makeCtx()
    ctx.runTextTurn = async (threadKey, text) => {
      captured.turns.push({ threadKey, text })
      return new Error("codex down")
    }

    await plugin.start(ctx)
    await plugin.waitForStartupTick()
    expect(captured.turns).toHaveLength(1)

    now = new Date(2026, 4, 7, 9, 31)
    await plugin.tickOnce()
    // one catch-up retry for the failed 9:30 fire
    expect(captured.turns).toHaveLength(2)

    now = new Date(2026, 4, 7, 9, 32)
    await plugin.tickOnce()
    now = new Date(2026, 4, 7, 9, 33)
    await plugin.tickOnce()
    // no retry storm: the walked floor stops the catch-up from re-firing
    expect(captured.turns).toHaveLength(2)
  })

  it("contains store errors thrown inside the catch-up path", async () => {
    const store = makeStore([cronEntry()])
    store.getLastFiredAt = () => {
      throw new Error("project removed mid-tick")
    }

    const plugin = buildPlugin(store, new Date(2026, 4, 7, 9, 30))
    const { ctx, captured } = makeCtx()

    await plugin.start(ctx)
    await expect(plugin.waitForStartupTick()).resolves.toBeUndefined()

    expect(captured.turns).toEqual([])
    expect(captured.logs.some((line) => line.includes("tick failed"))).toBe(true)
  })
})
