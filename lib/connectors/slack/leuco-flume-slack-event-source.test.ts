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
  createFlumeDefaultDeps: () => ({}),
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

import { LeucoMemorySlackSockets } from "@/connectors/slack/leuco-memory-slack-sockets"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { LeucoMemorySlackWakeClock } from "@/connectors/slack/leuco-memory-slack-wake-clock"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

const diagnosticOutput = new MemoryDiagnosticOutput()

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

  it.each(["startTimeoutMs", "wakeCheckIntervalMs"])(
    "rejects overflowing %s before scheduling timers",
    (name) => {
      expect(
        () =>
          new LeucoFlumeSlackEventSource({
            diagnosticOutput,
            createSockets: () => new LeucoMemorySlackSockets(),
            appToken: "xapp-test",
            botToken: "xoxb-test",
            [name]: MAX_TIMER_DELAY_MS + 1,
          }),
      ).toThrow(name)
    },
  )

  it("accepts the timer upper boundary without restricting the drift comparison", async () => {
    vi.useFakeTimers()
    const wake = new LeucoMemorySlackWakeClock()
    const interval = vi.spyOn(wake, "setInterval")
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
      wakeClock: wake,
      startTimeoutMs: MAX_TIMER_DELAY_MS,
      wakeCheckIntervalMs: MAX_TIMER_DELAY_MS,
      wakeDriftThresholdMs: MAX_TIMER_DELAY_MS + 1,
    })
    await source.start({ onEvent: async () => {} })
    expect(interval).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS)
    await source.stop()
  })

  it("leaves Flume's frame-silence watchdog disabled", async () => {
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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

  it("keeps socket and Flume cleanup failures together and blocks a fresh session", async () => {
    const sockets = new LeucoMemorySlackSockets()
    sockets.failure = new Error("native socket close unconfirmed")
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => sockets,
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({ onEvent: async () => {} })
    captured.close.mockRejectedValueOnce(new Error("Flume close failed"))
    const failure = await source.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error("Expected both cleanup failures")
    expect(
      failure.errors.map((error: unknown) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toEqual(["Flume close failed", "native socket close unconfirmed"])
    await expect(source.start({ onEvent: async () => {} })).rejects.toThrow("cleanup")
    sockets.failure = null
    await source.stop()
    expect(sockets.closeCalls).toBe(2)
  })

  it("records forced socket shutdown as a warning after confirmed cleanup", async () => {
    const sockets = new LeucoMemorySlackSockets()
    sockets.forcedCloses = 1
    const logs: Array<{ action: string; level: string }> = []
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => sockets,
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({
      onEvent: async () => {},
      onLog: (log) => {
        logs.push(log)
      },
    })
    await source.stop()
    expect(logs).toContainEqual(
      expect.objectContaining({ action: "socket.close.forced", level: "warn" }),
    )
    expect(sockets.closeCalls).toBe(1)
  })

  it("closes owned sockets even when Flume shutdown never returns", async () => {
    vi.useFakeTimers()
    const sockets = new LeucoMemorySlackSockets()
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => sockets,
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({ onEvent: async () => {} })
    captured.close.mockReturnValueOnce(new Promise(() => {}))
    const stopping = source.stop().then(
      () => null,
      (error: unknown) => error,
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets.closeCalls).toBe(1)
    const failure = await stopping
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("Expected shutdown timeout")
    expect(failure.message).toContain("Slack event source shutdown timed out")
    await expect(source.start({ onEvent: async () => {} })).rejects.toThrow("cleanup")
  })

  it("surfaces source failures and reconnect transitions", async () => {
    const logs: Array<{ action: string; level: string }> = []
    const statuses: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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

  it("contains callback errors whose properties cannot be inspected", async () => {
    const unreadable = Proxy.revocable({}, {})
    unreadable.revoke()
    const messages: string[] = []
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({
      onEvent: async () => {},
      onStatus: () => {
        throw unreadable.proxy
      },
      onLog: (log) => {
        messages.push(log.message)
      },
    })
    try {
      expect(() =>
        captured.flumeOptions[0]!.onEvent({
          kind: "log",
          log: {
            level: "info",
            action: "status",
            message: "connected",
            detail: { to: "connected" },
            timestamp: 1,
          },
        }),
      ).not.toThrow()
      expect(source.status()).toBe("connected")
      expect(messages).toContain("[unprintable thrown value]")
    } finally {
      await source.stop()
    }
  })

  it("keeps fallback diagnostics in one safe physical line", async () => {
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-private-token",
      botToken: "xoxb-private-token",
    })
    await source.start({ onEvent: async () => {} })
    try {
      captured.flumeOptions[0]!.onEvent({
        kind: "log",
        log: {
          level: "error",
          action: "broken\nforged",
          message: "xoxb-private-token\nline\r\u001b[2J\u009b31m\u2028end",
          timestamp: 1,
        },
      })
      expect(stderr).toHaveBeenCalledOnce()
      const line = String(stderr.mock.calls[0]![0])
      expect(line.endsWith("\n")).toBe(true)
      expect(line.slice(0, -1)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u)
      expect(line).toContain("\\n")
      expect(line).not.toContain("private-token")
    } finally {
      await source.stop()
      stderr.mockRestore()
    }
  })

  it("reports an asynchronous uninspectable log rejection without another rejection", async () => {
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    const unreadable = Proxy.revocable({}, {})
    unreadable.revoke()
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({
      onEvent: async () => {},
      onLog: async () => {
        throw unreadable.proxy
      },
    })
    try {
      captured.flumeOptions[0]!.onEvent({
        kind: "log",
        log: {
          level: "error",
          action: "socket.failed",
          message: "original socket failure",
          timestamp: 1,
        },
      })
      await vi.waitFor(() => expect(stderr).toHaveBeenCalledTimes(2))
      const output = stderr.mock.calls.map((call) => String(call[0])).join("")
      expect(output).toContain("original socket failure")
      expect(output).toContain("[unprintable thrown value]")
    } finally {
      await source.stop()
      stderr.mockRestore()
    }
  })

  it("contains simultaneous log consumer and fallback stderr failures", async () => {
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({
      onEvent: async () => {},
      onLog: () => {
        throw new Error("consumer failed")
      },
    })
    const stderr = vi.spyOn(diagnosticOutput, "write").mockImplementation(() => {
      throw Object.assign(new Error("stderr closed"), { code: "EPIPE" })
    })
    try {
      expect(() =>
        captured.flumeOptions[0]!.onEvent({
          kind: "log",
          log: {
            level: "error",
            action: "socket.failed",
            message: "original socket failure",
            timestamp: 1,
          },
        }),
      ).not.toThrow()
    } finally {
      stderr.mockRestore()
      await source.stop()
    }
  })
  it.each([false, true])(
    "retains fallback failure causes with async consumer=%s",
    async (usesConsumer) => {
      const source = new LeucoFlumeSlackEventSource({
        diagnosticOutput,
        createSockets: () => new LeucoMemorySlackSockets(),
        appToken: "xapp-private-token",
        botToken: "xoxb-private-token",
      })
      await source.start({
        onEvent: async () => {},
        onLog: usesConsumer
          ? async () => {
              throw new Error("consumer failed xoxb-private-token")
            }
          : undefined,
      })
      const stderr = vi.spyOn(diagnosticOutput, "write").mockImplementation(() => {
        throw Object.assign(new Error("stderr closed"), { code: "EPIPE" })
      })
      try {
        captured.flumeOptions[0]!.onEvent({
          kind: "log",
          log: {
            level: "error",
            action: "socket.failed",
            message: "original socket failure",
            timestamp: 1,
          },
        })
        await vi.waitFor(() => expect(source.getLogHealth().healthy).toBe(false))
        const health = source.getLogHealth()
        expect(health.lastFailure?.causes.map((cause) => cause.message)).toEqual(
          expect.arrayContaining(["original socket failure", "stderr closed"]),
        )
        expect(health.lastFailure?.causes.some((cause) => cause.code === "EPIPE")).toBe(true)
        expect(JSON.stringify(health)).not.toContain("private-token")
        health.lastFailure!.causes[0]!.message = "caller mutation"
        expect(source.getLogHealth().lastFailure?.causes[0]?.message).not.toBe("caller mutation")
      } finally {
        stderr.mockRestore()
        await source.stop()
      }
    },
  )

  it("does not let an older pending log acknowledge a newer failure as recovered", async () => {
    const pending = Promise.withResolvers<void>()
    const consumer = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockImplementationOnce(() => {
        throw new Error("newer write failed")
      })
      .mockReturnValue(undefined)
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({ onEvent: async () => {}, onLog: consumer })
    const emit = () =>
      captured.flumeOptions[0]!.onEvent({
        kind: "log",
        log: { level: "info", action: "socket.activity", message: "activity", timestamp: 1 },
      })
    try {
      emit()
      emit()
      expect(source.getLogHealth().healthy).toBe(false)
      const failed = source.getLogHealth().lastFailure
      pending.resolve()
      await pending.promise
      expect(source.getLogHealth().healthy).toBe(false)
      emit()
      await vi.waitFor(() => expect(source.getLogHealth().healthy).toBe(true))
      expect(source.getLogHealth().lastFailure).toEqual(failed)
    } finally {
      stderr.mockRestore()
      await source.stop()
    }
  })

  it("marks stalled log delivery uncertain without replaying it or trusting a late acknowledgment", async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<void>()
    const consumer = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(undefined)
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({ onEvent: async () => {}, onLog: consumer })
    const emit = () =>
      captured.flumeOptions[0]!.onEvent({
        kind: "log",
        log: { level: "info", action: "socket.activity", message: "stalled log", timestamp: 1 },
      })
    try {
      emit()
      await vi.advanceTimersByTimeAsync(1000)
      expect(source.getLogHealth().healthy).toBe(false)
      expect(consumer).toHaveBeenCalledOnce()
      expect(
        source
          .getLogHealth()
          .lastFailure?.causes.some((cause) =>
            cause.message.includes("Slack log delivery timed out"),
          ),
      ).toBe(true)
      pending.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getLogHealth().healthy).toBe(false)
      emit()
      await vi.advanceTimersByTimeAsync(0)
      expect(source.getLogHealth().healthy).toBe(true)
    } finally {
      stderr.mockRestore()
      await source.stop()
    }
  })

  it("bounds observation of a stalled fallback output without retrying that write", async () => {
    vi.useFakeTimers()
    const output = vi
      .spyOn(diagnosticOutput, "write")
      .mockReturnValueOnce(new Promise<void>(() => {}))
      .mockResolvedValue(undefined)
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
    await source.start({
      onEvent: async () => {},
      onLog: () => {
        throw new Error("consumer failed")
      },
    })
    try {
      captured.flumeOptions[0]!.onEvent({
        kind: "log",
        log: { level: "info", action: "socket.activity", message: "original log", timestamp: 1 },
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(output).toHaveBeenCalledTimes(2)
      expect(String(output.mock.calls[0]![0])).toContain("original log")
      expect(String(output.mock.calls[1]![0])).toContain("log.consumer.failed")
      expect(
        source
          .getLogHealth()
          .lastFailure?.causes.some((cause) =>
            cause.message.includes("Slack diagnostic output timed out"),
          ),
      ).toBe(true)
    } finally {
      output.mockRestore()
      await source.stop()
    }
  })

  it("recognizes cleanup errors resolved inside FlumeClosed instead of treating close as successful", async () => {
    const source = new LeucoFlumeSlackEventSource({
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
      appToken: "xapp-test",
      botToken: "xoxb-test",
    })
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
      diagnosticOutput,
      createSockets: () => new LeucoMemorySlackSockets(),
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
