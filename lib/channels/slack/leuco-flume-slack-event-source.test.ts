import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type RunningStub = {
  close: () => Promise<void>
}

const captured = vi.hoisted(() => ({
  sourceOptions: null as Record<string, unknown> | null,
  flumeOptions: [] as Array<{
    onEvent: (item: unknown) => void
    signal?: AbortSignal
  }>,
  openResults: [] as Array<RunningStub | Error | Promise<RunningStub | Error>>,
  openCalls: 0,
  close: vi.fn(async () => {}),
}))

vi.mock("@interactive-inc/flume/slack", () => ({
  FlumeSlackSource: class {
    constructor(options: Record<string, unknown>) {
      captured.sourceOptions = options
    }
  },
}))

vi.mock("@interactive-inc/flume", () => ({
  Flume: class {
    constructor(options: { onEvent: (item: unknown) => void }) {
      captured.flumeOptions.push(options)
    }

    async open() {
      captured.openCalls += 1
      const result = captured.openResults.shift()
      if (result !== undefined) return await result
      return { close: captured.close }
    }
  },
}))

import {
  LeucoFlumeSlackEventSource,
  type LeucoSlackWakeClock,
} from "@/channels/slack/leuco-flume-slack-event-source"

describe("LeucoFlumeSlackEventSource", () => {
  beforeEach(() => {
    captured.sourceOptions = null
    captured.flumeOptions = []
    captured.openResults = []
    captured.openCalls = 0
    captured.close.mockReset()
    captured.close.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("leaves Flume's frame-silence watchdog disabled", async () => {
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })

    await source.start({ onEvent: async () => {} })
    await source.stop()

    expect(captured.sourceOptions).toEqual({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    expect(captured.flumeOptions[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(captured.close).toHaveBeenCalledTimes(1)
  })

  it("surfaces source failures and reconnect transitions", async () => {
    const logs: Array<{ action: string; level: string }> = []
    const statuses: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })

    await source.start({
      onEvent: async () => {},
      onLog: (log) => logs.push({ action: log.action, level: log.level }),
      onStatus: (status) => statuses.push(status),
    })

    const onEvent = captured.flumeOptions[0]?.onEvent
    if (onEvent === undefined) throw new Error("expected Flume onEvent callback")

    onEvent({
      kind: "log",
      log: {
        level: "error",
        source: "slack.socket-mode",
        action: "ws.error",
        message: "WebSocket connection error",
        timestamp: 1_000,
      },
    })
    onEvent({
      kind: "log",
      log: {
        level: "info",
        source: "slack",
        action: "status",
        message: "connected -> reconnecting",
        detail: { to: "reconnecting" },
        timestamp: 1_001,
      },
    })
    await source.stop()

    expect(logs).toContainEqual({ action: "ws.error", level: "error" })
    expect(statuses).toContain("reconnecting")
  })

  it("reports disconnected even when closing the source fails", async () => {
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })

    await source.start({ onEvent: async () => {} })
    captured.close.mockRejectedValueOnce(new Error("close failed"))

    await expect(source.stop()).rejects.toThrow("close failed")
    expect(source.status()).toBe("disconnected")
  })

  it("aborts an open that exceeds the startup deadline and closes a late success", async () => {
    vi.useFakeTimers()
    const deferred = Promise.withResolvers<RunningStub | Error>()
    captured.openResults.push(deferred.promise)
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      startTimeoutMs: 25,
    })

    const starting = source.start({ onEvent: async () => {} })
    const rejected = expect(starting).rejects.toThrow(
      "Slack event source start timed out after 25ms",
    )
    await vi.advanceTimersByTimeAsync(25)
    await rejected

    expect(captured.flumeOptions[0]?.signal?.aborted).toBe(true)
    deferred.resolve({ close: captured.close })
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.close).toHaveBeenCalledTimes(1)
  })

  it("aborts an in-progress open immediately when stopped and closes a late success", async () => {
    const deferred = Promise.withResolvers<RunningStub | Error>()
    captured.openResults.push(deferred.promise)
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })

    const starting = source.start({ onEvent: async () => {} })
    const rejected = expect(starting).rejects.toThrow("Slack event source start cancelled")
    await source.stop()
    await rejected

    expect(captured.flumeOptions[0]?.signal?.aborted).toBe(true)
    deferred.resolve({ close: captured.close })
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.close).toHaveBeenCalledTimes(1)
  })

  it("rebuilds the Slack socket when timer drift indicates host suspension", async () => {
    const wake = createWakeClock()
    const logs: string[] = []
    const statuses: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
      wakeClock: wake.clock,
    })

    await source.start({
      onEvent: async () => {},
      onLog: (log) => logs.push(log.action),
      onStatus: (status) => statuses.push(status),
    })

    wake.advance(100)
    await Promise.resolve()
    expect(captured.openCalls).toBe(1)

    wake.advance(301)
    await vi.waitFor(() => {
      expect(captured.openCalls).toBe(2)
      expect(logs).toContain("wake.reconnected")
    })

    expect(logs).toContain("wake.detected")
    expect(statuses).toContain("reconnecting")
    expect(captured.close).toHaveBeenCalledTimes(1)
    expect(captured.flumeOptions[0]?.signal?.aborted).toBe(true)
    expect(captured.flumeOptions[1]?.signal?.aborted).toBe(false)

    await source.stop()
    expect(captured.close).toHaveBeenCalledTimes(2)
    expect(wake.clearCalls()).toBe(1)
  })

  it("retries a failed wake reconnect on the next watchdog check", async () => {
    const wake = createWakeClock()
    const logs: string[] = []
    const statuses: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
      wakeClock: wake.clock,
    })

    await source.start({
      onEvent: async () => {},
      onLog: (log) => logs.push(log.action),
      onStatus: (status) => statuses.push(status),
    })
    captured.openResults.push(new Error("Slack reconnect failed"))

    wake.advance(301)
    await vi.waitFor(() => {
      expect(logs).toContain("wake.reconnect.failed")
    })
    expect(captured.openCalls).toBe(2)
    expect(statuses).toContain("disconnected")

    wake.advance(100)
    await vi.waitFor(() => {
      expect(captured.openCalls).toBe(3)
      expect(logs.filter((action) => action === "wake.reconnected")).toHaveLength(1)
    })

    await source.stop()
    expect(captured.close).toHaveBeenCalledTimes(2)
  })

  it("cancels an in-progress wake reconnect when stopped", async () => {
    const wake = createWakeClock()
    const deferred = Promise.withResolvers<RunningStub | Error>()
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
      wakeClock: wake.clock,
    })

    await source.start({ onEvent: async () => {} })
    captured.openResults.push(deferred.promise)
    wake.advance(301)
    await vi.waitFor(() => {
      expect(captured.openCalls).toBe(2)
      expect(captured.close).toHaveBeenCalledTimes(1)
    })

    await source.stop()
    expect(source.status()).toBe("disconnected")
    expect(captured.flumeOptions[1]?.signal?.aborted).toBe(true)
    expect(wake.clearCalls()).toBe(1)

    deferred.resolve({ close: captured.close })
    await vi.waitFor(() => {
      expect(captured.close).toHaveBeenCalledTimes(2)
    })
  })
})

const createWakeClock = (): {
  clock: LeucoSlackWakeClock
  advance: (elapsedMs: number) => void
  clearCalls: () => number
} => {
  let now = 0
  let handler: (() => void) | null = null
  let clears = 0
  const handle = 1 as unknown as ReturnType<typeof setInterval>
  return {
    clock: {
      now: () => now,
      setInterval: (nextHandler) => {
        handler = nextHandler
        return handle
      },
      clearInterval: () => {
        clears += 1
        handler = null
      },
    },
    advance: (elapsedMs) => {
      now += elapsedMs
      handler?.()
    },
    clearCalls: () => clears,
  }
}
