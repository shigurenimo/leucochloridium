import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type RunningStub = {
  close: () => Promise<void>
}

const captured = vi.hoisted(() => ({
  sourceOptions: null as Record<string, unknown> | null,
  flumeOptions: null as {
    onEvent: (item: unknown) => void
    signal?: AbortSignal
  } | null,
  openResult: null as Promise<RunningStub | Error> | null,
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
      captured.flumeOptions = options
    }

    async open() {
      if (captured.openResult !== null) return await captured.openResult
      return { close: captured.close }
    }
  },
}))

import { LeucoFlumeSlackEventSource } from "@/channels/slack/leuco-flume-slack-event-source"

describe("LeucoFlumeSlackEventSource", () => {
  beforeEach(() => {
    captured.sourceOptions = null
    captured.flumeOptions = null
    captured.openResult = null
    captured.close.mockClear()
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
    expect(captured.flumeOptions?.signal).toBeInstanceOf(AbortSignal)
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

    const onEvent = captured.flumeOptions?.onEvent
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
    captured.openResult = deferred.promise
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

    expect(captured.flumeOptions?.signal?.aborted).toBe(true)
    deferred.resolve({ close: captured.close })
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.close).toHaveBeenCalledTimes(1)
  })

  it("aborts an in-progress open immediately when stopped and closes a late success", async () => {
    const deferred = Promise.withResolvers<RunningStub | Error>()
    captured.openResult = deferred.promise
    const source = new LeucoFlumeSlackEventSource({
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })

    const starting = source.start({ onEvent: async () => {} })
    const rejected = expect(starting).rejects.toThrow("Slack event source start cancelled")
    await source.stop()
    await rejected

    expect(captured.flumeOptions?.signal?.aborted).toBe(true)
    deferred.resolve({ close: captured.close })
    await Promise.resolve()
    await Promise.resolve()
    expect(captured.close).toHaveBeenCalledTimes(1)
  })
})
