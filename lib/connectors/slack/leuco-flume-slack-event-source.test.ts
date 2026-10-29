import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type ClosedStub = {
  errors: () => ReadonlyArray<{ source: string; errorCode?: string; error: Error }>
}
type RunningStub = { close: () => Promise<ClosedStub> }

const captured = vi.hoisted(() => ({
  sourceOptions: null as Record<string, unknown> | null,
  flumeOptions: [] as Array<{
    onEvent: (item: unknown) => void
    signal?: AbortSignal
  }>,
  openResults: [] as Array<RunningStub | Error | Promise<RunningStub | Error>>,
  openCalls: 0,
  close: vi.fn(async (): Promise<ClosedStub> => ({ errors: () => [] })),
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

import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { LeucoMemorySlackWakeClock } from "@/connectors/slack/leuco-memory-slack-wake-clock"

describe("LeucoFlumeSlackEventSource", () => {
  beforeEach(() => {
    captured.sourceOptions = null
    captured.flumeOptions = []
    captured.openResults = []
    captured.openCalls = 0
    captured.close.mockReset()
    captured.close.mockResolvedValue({ errors: () => [] })
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
    await vi.waitFor(() => expect(captured.close).toHaveBeenCalledTimes(1))
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
    await vi.waitFor(() => expect(captured.close).toHaveBeenCalledTimes(1))
  })

  it("rebuilds the Slack socket when timer drift indicates host suspension", async () => {
    const wake = new LeucoMemorySlackWakeClock()
    const logs: string[] = []
    const statuses: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
      wakeClock: wake,
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
    const wake = new LeucoMemorySlackWakeClock()
    const logs: string[] = []
    const statuses: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
      wakeClock: wake,
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
    const wake = new LeucoMemorySlackWakeClock()
    const deferred = Promise.withResolvers<RunningStub | Error>()
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
      wakeClock: wake,
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
  it("does not open another socket after the previous socket failed to close", async () => {
    const wake = new LeucoMemorySlackWakeClock()
    const logs: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeClock: wake,
      wakeCheckIntervalMs: 100,
      wakeDriftThresholdMs: 200,
    })
    await source.start({
      onEvent: async () => {},
      onLog: (log) => {
        logs.push(log.action)
      },
    })
    captured.close.mockRejectedValueOnce(new Error("old socket close unconfirmed"))
    wake.advance(301)
    await vi.waitFor(() => expect(logs).toContain("wake.close.failed"))
    expect(captured.openCalls).toBe(1)
    expect(source.status()).toBe("disconnected")
    wake.advance(100)
    await vi.waitFor(() => expect(captured.openCalls).toBe(2))
    expect(captured.close).toHaveBeenCalledTimes(2)
    await source.stop()
  })

  it("retains a failed cleanup so stop can retry it and start cannot hide it", async () => {
    const source = new LeucoFlumeSlackEventSource({ appToken: "xapp-test", botToken: "xoxb-test" })
    await source.start({ onEvent: async () => {} })
    captured.close.mockRejectedValueOnce(new Error("socket close failed"))
    await expect(source.stop()).rejects.toThrow("socket close failed")
    await expect(source.start({ onEvent: async () => {} })).rejects.toThrow("cleanup")
    await source.stop()
    expect(captured.close).toHaveBeenCalledTimes(2)
  })
  it("reports watchdog cancellation failure and retries it without skipping socket shutdown", async () => {
    const wake = new LeucoMemorySlackWakeClock()
    const cancel = vi.fn().mockImplementationOnce(() => {
      throw new Error("watchdog cancel failed")
    })
    vi.spyOn(wake, "setInterval").mockReturnValue(cancel)
    const logs: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeClock: wake,
    })
    await source.start({
      onEvent: async () => {},
      onLog: (log) => {
        logs.push(log.action)
      },
    })
    await expect(source.stop()).rejects.toThrow("watchdog cancel failed")
    expect(captured.close).toHaveBeenCalledOnce()
    expect(logs).toContain("wake.watchdog.cancel.failed")
    await source.stop()
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it("contains failing status and log consumers while preserving status and redacting diagnostics", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-private-token",
      botToken: "xoxb-private-token",
    })
    try {
      await source.start({
        onEvent: async () => {},
        onStatus: () => {
          throw new Error("status consumer failed")
        },
        onLog: async () => {
          throw new Error("log consumer failed xoxb-private-token")
        },
      })
      const emit = captured.flumeOptions[0]!.onEvent
      expect(() =>
        emit({
          kind: "log",
          log: {
            level: "error",
            action: "status",
            message: "socket state",
            detail: { to: "reconnecting" },
            timestamp: 1,
          },
        }),
      ).not.toThrow()
      await vi.waitFor(() => expect(stderr).toHaveBeenCalled())
      expect(source.status()).toBe("reconnecting")
      expect(stderr.mock.calls.map(String).join(" ")).toContain("socket state")
      expect(stderr.mock.calls.map(String).join(" ")).not.toContain("private-token")
    } finally {
      await source.stop()
      stderr.mockRestore()
    }
  })
  it("recognizes cleanup errors resolved inside FlumeClosed instead of treating close as successful", async () => {
    const source = new LeucoFlumeSlackEventSource({ appToken: "xapp-test", botToken: "xoxb-test" })
    await source.start({ onEvent: async () => {} })
    captured.close.mockResolvedValueOnce({
      errors: () => [
        {
          source: "slack",
          errorCode: "FLUME_STOP_FAILED",
          error: new Error("source disconnect failed"),
        },
      ],
    })
    await expect(source.stop()).rejects.toThrow("source disconnect failed")
    expect(source.status()).toBe("disconnected")
    await source.stop()
  })

  it("does not claim successful startup when wake monitoring could not be installed", async () => {
    const wake = new LeucoMemorySlackWakeClock()
    vi.spyOn(wake, "setInterval").mockImplementation(() => {
      throw new Error("watchdog setup failed")
    })
    const logs: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeClock: wake,
    })
    await expect(
      source.start({
        onEvent: async () => {},
        onLog: (log) => {
          logs.push(log.action)
        },
      }),
    ).rejects.toThrow("watchdog setup failed")
    expect(logs).toContain("wake.watchdog.schedule.failed")
    expect(captured.close).toHaveBeenCalledOnce()
    expect(source.status()).toBe("disconnected")
    await source.stop()
  })
})
