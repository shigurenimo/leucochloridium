import { describe, expect, it, vi } from "vitest"
import type { ConnectorContext } from "@/connectors/connector"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
describe("runtime inspection", () => {
  it("keeps a caller-owned event log open for the remaining shutdown diagnostics", async () => {
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex: new MemoryCodexClient(),
      connections: [],
      eventLog: events,
      env: {},
    })
    try {
      await runtime.start()
      await runtime.stop()
      expect(events.getHealth().closed).toBe(false)
      events.log("warn", "control server finished draining", "shutdown-request")
      expect(events.query({ requestId: "shutdown-request" })[0]?.event).toMatchObject({
        type: "log",
        line: "control server finished draining",
      })
    } finally {
      await runtime.stop()
      events.close()
    }
  })
  it("closes the default event log owned by the runtime", async () => {
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex: new MemoryCodexClient(),
      connections: [],
      env: {},
    })
    await runtime.start()
    await runtime.stop()
    expect(runtime.getStatus().logs.closed).toBe(true)
  })
  it("keeps a caller's startup failure diagnostics writable after failed initialization", async () => {
    const events = new LeucoEventLog()
    const codex = new MemoryCodexClient()
    codex.startError = Object.assign(new Error("initialization failed"), { code: "EIO" })
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      connections: [],
      eventLog: events,
      env: {},
    })
    try {
      await expect(runtime.start()).rejects.toBe(codex.startError)
      expect(events.getHealth().closed).toBe(false)
      events.error("owner observed startup failure", codex.startError, "boot-request")
      expect(events.query({ requestId: "boot-request" })[0]?.event).toMatchObject({
        type: "log",
        causes: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
      })
    } finally {
      await runtime.stop()
      events.close()
    }
  })
  it("still closes an internally created log after failed initialization", async () => {
    const codex = new MemoryCodexClient()
    codex.startError = new Error("initialization failed")
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      connections: [],
      env: {},
    })
    await expect(runtime.start()).rejects.toBe(codex.startError)
    expect(runtime.getStatus().logs.closed).toBe(true)
  })
  it.each([-60000, 60000])(
    "keeps turn and queue durations when wall time shifts by %i ms",
    async (shift) => {
      vi.useFakeTimers()
      const codex = new MemoryCodexClient()
      codex.hold = true
      const events = new LeucoEventLog()
      const runtime = LeucoRuntime.build({
        store: new MemoryLeucoStore(),
        codex,
        eventLog: events,
        connections: [],
        env: {},
      })
      try {
        await runtime.start()
        const first = runtime.runTextTurn("first", "hold", "clock-first")
        for (const _ of Array.from({ length: 20 })) await Promise.resolve()
        const second = runtime.runTextTurn("second", "hold", "clock-second")
        await vi.advanceTimersByTimeAsync(100)
        vi.setSystemTime(Date.now() + shift)
        codex.complete("first done")
        await first
        for (const _ of Array.from({ length: 20 })) await Promise.resolve()
        expect(runtime.getStatus().active?.startedAt).toBe(Date.now())
        await vi.advanceTimersByTimeAsync(50)
        codex.complete("second done")
        await second
        const history = events.query()
        expect(
          history.find(
            (entry) =>
              entry.event.type === "turn.complete" && entry.event.requestId === "clock-first",
          )?.event,
        ).toMatchObject({ durationMs: 100 })
        expect(
          history.find(
            (entry) =>
              entry.event.type === "turn.start" && entry.event.requestId === "clock-second",
          )?.event,
        ).toMatchObject({ queueWaitMs: 100 })
        expect(
          history.find(
            (entry) =>
              entry.event.type === "turn.complete" && entry.event.requestId === "clock-second",
          )?.event,
        ).toMatchObject({ durationMs: 50 })
        expect(events.getHealth().failedWrites).toBe(0)
      } finally {
        await runtime.stop()
        vi.useRealTimers()
      }
    },
  )
  it("masks control-token fragments before bounding persisted error causes", () => {
    const events = new LeucoEventLog()
    const secret = "control-0123456789-abcdefghijklmnopqrstuvwxyz"
    events.addRedactionSecrets([secret])
    events.error("bounded failure", new Error(`${"m".repeat(3988)}${secret}`))
    const history = JSON.stringify(events.query())
    expect(history).not.toContain("control-")
    expect(history).toContain("[redacted]")
    events.close()
  })
  it("preserves source log severity instead of downgrading it to info", async () => {
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex: new MemoryCodexClient(),
      eventLog: events,
      env: {},
      connections: [
        {
          name: "diagnostic",
          getIdentity: () => ({ name: "diagnostic", type: "schedule", botUserId: null }),
          start: async (context) => {
            context.onLog("source warning", "warn")
            context.onLog("source failure", "error")
          },
          stop: async () => {},
        },
      ],
    })
    await runtime.start()
    expect(
      events
        .query()
        .filter((entry) => entry.event.type === "log")
        .map((entry) => entry.event),
    ).toMatchObject([
      { level: "warn", line: "source warning" },
      { level: "error", line: "source failure" },
    ])
    await runtime.stop()
  })
  it("shows active and waiting request IDs and correlates completion without exposing input in status", async () => {
    const codex = new MemoryCodexClient()
    codex.hold = true
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      eventLog: events,
      connections: [],
      env: {},
    })
    await runtime.start()
    const first = runtime.runTextTurn("first", "private prompt", "request-one")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    const second = runtime.runTextTurn("second", "other prompt", "request-two")
    expect(runtime.getStatus()).toMatchObject({
      active: { requestId: "request-one" },
      queue: { waiting: 1, requests: [{ requestId: "request-two" }] },
    })
    expect(JSON.stringify(runtime.getStatus())).not.toContain("private prompt")
    codex.complete("done")
    expect(await first).toBe("done")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    codex.complete("done-two")
    expect(await second).toBe("done-two")
    const firstEvents = events.query().filter((entry) => entry.event.requestId === "request-one")
    expect(firstEvents.map((entry) => entry.event.type)).toEqual([
      "turn.queued",
      "turn.start",
      "turn.complete",
    ])
    expect(firstEvents.every((entry) => entry.event.instanceId === runtime.instanceId)).toBe(true)
    await runtime.stop()
  })
  it("records rejected requests and every queued cancellation without treating shutdown as a failure", async () => {
    const codex = new MemoryCodexClient()
    codex.hold = true
    const events = new LeucoEventLog()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      eventLog: events,
      connections: [],
      env: {},
    })
    await runtime.start()
    const held = runtime.runTextTurn("held", "hold", "held-id")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    const queued = runtime.runTextTurn("queued", "wait", "queued-id")
    expect(
      await runtime.runTextTurn("too-big", "x".repeat(256 * 1024), "rejected-id"),
    ).toBeInstanceOf(Error)
    expect(
      events.query().find((entry) => entry.event.requestId === "rejected-id")?.event,
    ).toMatchObject({ type: "turn.rejected", reason: "queue_bytes_limit" })
    await runtime.stop()
    expect(await held).toBeInstanceOf(Error)
    expect(await queued).toBeInstanceOf(Error)
    expect(runtime.getStatus().lastFailure).toBe(null)
    expect(
      events
        .query()
        .find((entry) => entry.event.requestId === "queued-id" && entry.event.type === "turn.error")
        ?.event,
    ).toMatchObject({ cancelled: true })
  })
})

it("exposes volatile history in the default library memory configuration", async () => {
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    codex: new MemoryCodexClient(),
    connections: [],
    env: {},
  })
  try {
    await runtime.start()
    expect(runtime.getStatus().logs).toMatchObject({ mode: "memory", durable: false })
    await runtime.runTextTurn("cli", "library history", "memory-request")
    const history = runtime.getVolatileEvents({
      requestId: "memory-request",
      type: "turn.complete",
      limit: 1,
    })
    expect(history).toHaveLength(1)
    expect(history[0]?.event).toMatchObject({
      type: "turn.complete",
      requestId: "memory-request",
      reply: "done",
    })
    expect(runtime.getStatus().logs.memoryWrites).toBeGreaterThan(0)
  } finally {
    await runtime.stop()
  }
})

it("settles a host's asynchronous log before closing the runtime-owned event log", async () => {
  const pending = Promise.withResolvers<void>()
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    codex: new MemoryCodexClient(),
    env: {},
    onLog: () => pending.promise,
    connections: [
      {
        name: "probe",
        getIdentity: () => ({ name: "probe", type: "schedule", botUserId: null }),
        start: async (context) => context.onLog("record"),
        stop: async () => {},
      },
    ],
  })
  await runtime.start()
  const stopping = runtime.stop()
  expect(runtime.getStatus().logs.closed).toBe(false)
  expect(runtime.getStatus().lifecycle).toBe("stopping")
  pending.reject(Object.assign(new Error("sink failed"), { code: "EIO" }))
  await stopping
  expect(runtime.getStatus()).toMatchObject({
    logs: { closed: true },
    logConsumer: {
      healthy: false,
      pending: 0,
      lastFailure: { causes: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]) },
    },
  })
})

it("keeps background and late connector diagnostics out of an unrelated active request", async () => {
  const context: { value: ConnectorContext | null } = { value: null }
  const codex = new MemoryCodexClient()
  codex.hold = true
  const events = new LeucoEventLog()
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    codex,
    eventLog: events,
    env: {},
    onLog: (line) => {
      if (line === "previous request failure") throw new Error("sink failed")
    },
    connections: [
      {
        name: "probe",
        getIdentity: () => ({ name: "probe", type: "schedule", botUserId: null }),
        start: async (received) => {
          context.value = received
        },
        stop: async () => {},
      },
    ],
  })
  try {
    await runtime.start()
    const active = runtime.runTextTurn("current", "hold", "current-request")
    for (const _ of Array.from({ length: 20 })) await Promise.resolve()
    expect(runtime.getStatus().active?.requestId).toBe("current-request")
    context.value!.onLog("background reconnect", "warn")
    context.value!.onLog("previous request failure", "error", "previous-request")
    const background = events
      .query()
      .find((entry) => entry.event.type === "log" && entry.event.line === "background reconnect")
    expect(background?.event.requestId).toBeUndefined()
    const previous = events.query({ requestId: "previous-request" })
    expect(previous.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: "previous request failure", level: "error" }),
        expect.objectContaining({ line: "Log consumer failed: sink failed" }),
      ]),
    )
    expect(runtime.getStatus().logConsumer.lastFailure?.requestId).toBe("previous-request")
    codex.complete()
    await active
  } finally {
    await runtime.stop()
    events.close()
  }
})

it.each(["startup", "turn"])(
  "bounds %s status failures after masking without changing the original error",
  async (phase) => {
    const secret = "synthetic-owner-status-credential"
    const failure = Object.assign(new Error(`${"p".repeat(3980)}${secret}${"q".repeat(20000)}`), {
      code: "ESTATUS",
    })
    const events = new LeucoEventLog()
    events.addRedactionSecrets([secret])
    const codex = new MemoryCodexClient()
    if (phase === "startup") codex.startError = failure
    else codex.reply = failure
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      connections: [],
      eventLog: events,
      env: {},
    })
    try {
      if (phase === "startup") await expect(runtime.start()).rejects.toBe(failure)
      else {
        await runtime.start()
        await runtime.runTextTurn("status-probe", "test", "status-request")
      }
      const message = runtime.getStatus().lastFailure?.message
      expect(message?.length).toBeLessThanOrEqual(4000)
      expect(message).toContain("[truncated]")
      expect(message).not.toContain(secret.slice(0, 8))
      expect(failure.message).toContain(secret)
      expect(events.query().some((entry) => JSON.stringify(entry.event).includes("ESTATUS"))).toBe(
        true,
      )
    } finally {
      await runtime.stop()
      events.close()
    }
  },
)

it("does not let callers edit retained history through getVolatileEvents", async () => {
  const events = new LeucoEventLog()
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    codex: new MemoryCodexClient(),
    connections: [],
    eventLog: events,
    env: {},
  })
  try {
    events.log("warn", "original diagnostic", "original-request")
    const record = runtime.getVolatileEvents({})[0]!
    if (record.event.type !== "log") throw new Error("Expected log")
    record.event.line = "caller mutation"
    record.event.requestId = "changed-request"
    expect(runtime.getVolatileEvents({})[0]?.event).toMatchObject({
      line: "original diagnostic",
      requestId: "original-request",
    })
  } finally {
    await runtime.stop()
    events.close()
  }
})

it("detaches injected Codex and connection status from both the caller and the producer", async () => {
  const codexStatus = {
    pid: 42,
    ready: true,
    starting: false,
    stopping: false,
    cleaningUp: false,
    activeTurns: 0,
  }
  const connectionStatus = {
    state: "ready",
    lastActivityAt: null,
    lastFailure: { ts: 1, message: "original diagnostic" },
  }
  const codex = Object.assign(new MemoryCodexClient(), { getStatus: () => codexStatus })
  const runtime = LeucoRuntime.build({
    store: new MemoryLeucoStore(),
    codex,
    env: {},
    connections: [
      {
        name: "shared",
        start: async () => {},
        stop: async () => {},
        getIdentity: () => ({ name: "shared", type: "schedule", botUserId: null }),
        getStatus: () => connectionStatus,
      },
    ],
  })
  try {
    await runtime.start()
    const observed = runtime.getStatus()
    observed.codex!.ready = false
    observed.connections[0]!.health!.lastFailure!.message = "caller mutation"
    expect(codexStatus.ready).toBe(true)
    expect(connectionStatus.lastFailure.message).toBe("original diagnostic")
    codexStatus.pid = 99
    connectionStatus.lastFailure.message = "producer later update"
    expect(observed.codex?.pid).toBe(42)
    expect(observed.connections[0]?.health?.lastFailure?.message).toBe("caller mutation")
  } finally {
    await runtime.stop()
  }
})
