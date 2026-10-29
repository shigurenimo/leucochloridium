import { describe, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { Connector } from "@/connectors/connector"

async function flush() {
  for (const _ of Array.from({ length: 30 })) await Promise.resolve()
}

describe("runtime failure boundaries", () => {
  it("settles shutdown immediately even while thread initialization is unresponsive", async () => {
    const codex = new MemoryCodexClient()
    const initializing = Promise.withResolvers<{ thread: { id: string } }>()
    codex.startThread = () => initializing.promise
    const runtime = LeucoRuntime.build({
      codex,
      store: new MemoryLeucoStore(),
      connections: [],
      env: {},
    })
    await runtime.start()
    const reply = runtime.runTextTurn("cli", "waiting", "initialization")
    await flush()
    const observation = { stopped: false }
    const stopping = runtime.stop().then(() => {
      observation.stopped = true
    })
    await flush()
    const stoppedBeforeLateResult = observation.stopped
    initializing.resolve({ thread: { id: "late" } })
    await stopping
    expect(stoppedBeforeLateResult).toBe(true)
    expect(await reply).toBeInstanceOf(Error)
    expect(codex.turns).toHaveLength(0)
  })

  it("reports every connector cleanup failure and still closes all resources", async () => {
    const events = new LeucoEventLog()
    const stop = vi.fn(async () => {
      throw new Error("socket shutdown failed")
    })
    const otherStop = vi.fn(async () => {})
    const connector = (name: string, close: () => Promise<void>): Connector => ({
      name,
      start: async () => {},
      stop: close,
      getIdentity: () => ({ name, type: "slack", botUserId: null }),
    })
    const runtime = LeucoRuntime.build({
      codex: new MemoryCodexClient(),
      store: new MemoryLeucoStore(),
      eventLog: events,
      connections: [connector("bad", stop), connector("other", otherStop)],
      env: {},
    })
    await runtime.start()
    const outcome = await runtime.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(otherStop).toHaveBeenCalledOnce()
    expect(runtime.getStatus().lifecycle).toBe("stopped")
    expect(
      events
        .query()
        .some(
          (entry) =>
            entry.event.type === "log" &&
            entry.event.level === "error" &&
            entry.event.line.includes("socket shutdown failed"),
        ),
    ).toBe(true)
    expect(outcome).toBeInstanceOf(AggregateError)
  })

  it("a throwing log consumer cannot turn a successful turn into a failed request", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const codex = new MemoryCodexClient()
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      codex,
      store: new MemoryLeucoStore(),
      eventLog: events,
      connections: [
        {
          name: "logging",
          start: async (context) => context.onLog("starting connector"),
          stop: async () => {},
          getIdentity: () => ({ name: "logging", type: "slack", botUserId: null }),
        },
      ],
      env: {},
      onLog: () => {
        throw new Error("consumer exploded")
      },
    })
    await runtime.start()
    await codex.stop()
    const reply = await runtime.runTextTurn("cli", "fresh request", "observer-id")
    await runtime.stop()
    stderr.mockRestore()
    expect(reply).toBe("done")
    expect(
      events
        .query()
        .some(
          (entry) =>
            entry.event.type === "log" &&
            entry.event.level === "error" &&
            entry.event.line.includes("consumer exploded"),
        ),
    ).toBe(true)
  })

  it("preserves the startup cause when cleanup also fails", async () => {
    const codex = new MemoryCodexClient()
    codex.startError = new Error("initialization root cause")
    codex.stop = async () => {
      throw new Error("cleanup secondary cause")
    }
    const runtime = LeucoRuntime.build({
      codex,
      store: new MemoryLeucoStore(),
      connections: [],
      env: {},
    })
    const failure = await runtime.start().then(
      () => null,
      (error: unknown) => error,
    )
    expect(String(failure)).toContain("initialization root cause")
    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError)
      expect(failure.errors.map(String).join(" ")).toContain("cleanup secondary cause")
  })
})
