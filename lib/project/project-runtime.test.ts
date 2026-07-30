import { describe, expect, it, vi } from "vitest"
import type { ConnectorIdentity, Connector, ConnectorContext } from "@/connectors/connector"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import type { ScheduleStorePort } from "@/connectors/schedule/schedule-store-port"
import type { ConversationScope, ScheduleEntry } from "@/config/config-schema"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoProjectRuntime } from "@/project/project-runtime"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { LeucoEvent } from "@/events/leuco-event-types"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"

const fakeCodex = (overrides: Partial<CodexClientPort> = {}): CodexClientPort => ({
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: () => true,
  startThread: async () => ({ thread: { id: `thread-${Math.random()}` } }),
  resumeThread: async (params) => ({ thread: { id: params.threadId } }),
  runTextTurn: async (_id, text) => `echo:${text}`,
  interruptTurn: async () => ({ status: "not-active" }),
  ...overrides,
})

const fakeConnector = (
  name: string,
  identity?: Partial<ConnectorIdentity>,
): Connector & { ctx: ConnectorContext | null } => {
  const connector: Connector & { ctx: ConnectorContext | null } = {
    name,
    ctx: null,
    async start(ctx) {
      connector.ctx = ctx
    },
    async stop() {
      connector.ctx = null
    },
    getIdentity: () => ({ name, type: "slack", botUserId: null, ...identity }),
  }
  return connector
}

type BuildOverrides = {
  codex?: CodexClientPort
  connectors?: Connector[]
  agentSpec?: { developerInstructions?: string; model?: string }
  initialCodexThreadId?: string
  useCommonInstructions?: boolean
  presets?: string[]
  onLog?: (line: string) => void
  eventLog?: LeucoEventLog
  turnTimeoutMs?: number
  turnIdleTimeoutMs?: number
  turnInterruptGraceMs?: number
  turnConcurrency?: number
  turnQueueMaxItems?: number
  turnQueueMaxBytes?: number
  conversationScope?: ConversationScope
  initialCodexThreadIds?: Readonly<Record<string, string>>
  projectStateStore?: Pick<LeucoProjectStateStore, "setCodexThreadId" | "setCodexThreadIds">
}

const buildRuntime = (overrides: BuildOverrides = {}) =>
  new LeucoProjectRuntime({
    projectId: "00000000-0000-4000-8000-000000000000",
    projectName: "demo",
    projectPath: "/tmp/demo",
    codexHome: "/tmp/leuco/demo/.codex",
    timeZone: "Asia/Tokyo",
    codex: overrides.codex ?? fakeCodex(),
    connectors: overrides.connectors ?? [],
    agentSpec: overrides.agentSpec,
    initialCodexThreadId: overrides.initialCodexThreadId,
    useCommonInstructions: overrides.useCommonInstructions,
    presets: overrides.presets,
    onLog: overrides.onLog ?? (() => {}),
    eventLog: overrides.eventLog,
    conversationScope: overrides.conversationScope,
    turnTimeoutMs: overrides.turnTimeoutMs,
    turnIdleTimeoutMs: overrides.turnIdleTimeoutMs,
    turnInterruptGraceMs: overrides.turnInterruptGraceMs,
    turnConcurrency: overrides.turnConcurrency,
    turnQueueMaxItems: overrides.turnQueueMaxItems,
    turnQueueMaxBytes: overrides.turnQueueMaxBytes,
    initialCodexThreadIds: overrides.initialCodexThreadIds,
    projectStateStore: overrides.projectStateStore,
  })

describe("LeucoProjectRuntime.start / stop", () => {
  it("starts codex first, then each connector", async () => {
    const calls: string[] = []
    const codex = fakeCodex({
      start: async () => {
        calls.push("codex.start")
      },
    })
    const a = fakeConnector("a")
    const b = fakeConnector("b")
    a.start = async () => {
      calls.push("a.start")
    }
    b.start = async () => {
      calls.push("b.start")
    }

    await buildRuntime({ codex, connectors: [a, b] }).start()

    expect(calls).toEqual(["codex.start", "a.start", "b.start"])
  })

  it("stops connectors, then codex", async () => {
    const calls: string[] = []
    const codex = fakeCodex({
      stop: async () => {
        calls.push("codex.stop")
      },
    })
    const a = fakeConnector("a")
    a.stop = async () => {
      calls.push("a.stop")
    }

    const runtime = buildRuntime({ codex, connectors: [a] })
    await runtime.start()
    await runtime.stop()

    expect(calls).toEqual(["a.stop", "codex.stop"])
  })

  it("stops codex before waiting for an in-flight connector turn to settle", async () => {
    let releaseConnectorStop: (() => void) | null = null
    const connectorStopGate = new Promise<void>((resolve) => {
      releaseConnectorStop = resolve
    })
    const calls: string[] = []
    const connector = fakeConnector("schedule")
    connector.stop = async () => {
      calls.push("connector.stop.begin")
      await connectorStopGate
      calls.push("connector.stop.end")
    }
    const codex = fakeCodex({
      stop: async () => {
        calls.push("codex.stop")
        if (releaseConnectorStop !== null) releaseConnectorStop()
      },
    })
    const runtime = buildRuntime({ codex, connectors: [connector] })

    await runtime.start()
    await runtime.stop()

    expect(calls).toEqual(["connector.stop.begin", "codex.stop", "connector.stop.end"])
  })

  it("still stops codex when a connector throws synchronously during shutdown", async () => {
    const calls: string[] = []
    const connector = fakeConnector("broken")
    connector.stop = () => {
      throw new Error("stop failed")
    }
    const runtime = buildRuntime({
      codex: fakeCodex({
        stop: async () => {
          calls.push("codex.stop")
        },
      }),
      connectors: [connector],
    })

    await runtime.start()
    await runtime.stop()

    expect(calls).toEqual(["codex.stop"])
  })

  it("replaces only the requested connector and keeps the replacement for shutdown", async () => {
    const calls: string[] = []
    const current = fakeConnector("slack")
    current.stop = async () => {
      calls.push("current.stop")
    }
    const replacement = fakeConnector("slack")
    replacement.start = async () => {
      calls.push("replacement.start")
    }
    replacement.stop = async () => {
      calls.push("replacement.stop")
    }
    const sibling = fakeConnector("schedule")
    sibling.stop = async () => {
      calls.push("sibling.stop")
    }
    const runtime = buildRuntime({ connectors: [current, sibling] })

    await runtime.restartConnector("slack", replacement)
    await runtime.stop()

    expect(calls).toEqual(["current.stop", "replacement.start", "replacement.stop", "sibling.stop"])
  })

  it("restores the current connector when its replacement fails to start", async () => {
    const calls: string[] = []
    const current = fakeConnector("slack")
    current.start = async () => {
      calls.push("current.start")
    }
    current.stop = async () => {
      calls.push("current.stop")
    }
    const replacement = fakeConnector("slack")
    replacement.start = async () => {
      calls.push("replacement.start")
      throw new Error("replacement failed")
    }
    replacement.stop = async () => {
      calls.push("replacement.stop")
    }
    const runtime = buildRuntime({ connectors: [current] })

    await expect(runtime.restartConnector("slack", replacement)).rejects.toThrow(
      "replacement failed",
    )

    expect(calls).toEqual([
      "current.stop",
      "replacement.start",
      "replacement.stop",
      "current.start",
    ])
  })

  it("rolls back codex and earlier connectors when a later connector start fails", async () => {
    const calls: string[] = []
    const codex = fakeCodex({
      start: async () => {
        calls.push("codex.start")
      },
      stop: async () => {
        calls.push("codex.stop")
      },
    })
    const a = fakeConnector("a")
    a.start = async () => {
      calls.push("a.start")
    }
    a.stop = async () => {
      calls.push("a.stop")
    }
    const b = fakeConnector("b")
    b.start = async () => {
      calls.push("b.start")
      throw new Error("b boom")
    }
    b.stop = async () => {
      calls.push("b.stop")
    }

    const runtime = buildRuntime({ codex, connectors: [a, b] })
    await expect(runtime.start()).rejects.toThrow("b boom")

    // a started, b threw mid-start, rollback stops a in reverse + codex.
    expect(calls).toEqual(["codex.start", "a.start", "b.start", "a.stop", "codex.stop"])
  })

  it("settles queued turns while stopping", async () => {
    let finishActive: (() => void) | undefined
    const runtime = buildRuntime({
      codex: fakeCodex({
        stop: async () => finishActive?.(),
        runTextTurn: async () =>
          await new Promise<string>((resolve) => {
            finishActive = () => resolve("active finished")
          }),
      }),
    })

    const active = runtime.runTextTurn("same", "active")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const queued = runtime.runTextTurn("same", "queued")

    await runtime.stop()

    await expect(active).resolves.toBe("active finished")
    const queuedResult = await queued
    expect(queuedResult).toBeInstanceOf(Error)
    if (queuedResult instanceof Error) {
      expect(queuedResult.message).toBe("project runtime demo is stopping")
    }
  })

  it("stops Codex while an earlier schedule connector drains during start rollback", async () => {
    const entry: ScheduleEntry = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "due",
      runAt: "2026-05-07T09:00:00Z",
      prompt: "run",
      enabled: true,
    }
    const storeMutations = { marks: 0, removes: 0 }
    const store: ScheduleStorePort = {
      listEntries: () => [entry],
      getLastFiredAt: () => null,
      markFired: () => {
        storeMutations.marks += 1
      },
      removeEntry: () => {
        storeMutations.removes += 1
      },
    }
    const schedule = new LeucoScheduleConnector({
      name: "schedule",
      store,
      now: () => new Date("2026-05-07T09:01:00Z"),
      intervalMs: 60 * 60 * 1000,
    })
    const turnResolvers: Array<(reply: string | Error) => void> = []
    let reportTurnStarted: () => void = () => {}
    const turnStarted = new Promise<void>((resolve) => {
      reportTurnStarted = resolve
    })
    const stop = vi.fn(async () => {
      const resolveTurn = turnResolvers[0]
      if (resolveTurn) resolveTurn(new Error("codex stopped"))
    })
    const codex = fakeCodex({
      stop,
      runTextTurn: () =>
        new Promise<string | Error>((resolve) => {
          turnResolvers.push(resolve)
          reportTurnStarted()
        }),
    })
    const failing = fakeConnector("failing")
    failing.start = async () => {
      await turnStarted
      throw new Error("later connector failed")
    }
    const runtime = buildRuntime({ codex, connectors: [schedule, failing] })

    await expect(runtime.start()).rejects.toThrow("later connector failed")

    expect(stop).toHaveBeenCalledTimes(1)
    expect(storeMutations).toEqual({ marks: 0, removes: 0 })
  })
})

describe("LeucoProjectRuntime.runTextTurn", () => {
  it("starts a new codex thread on first call and reuses it on subsequent calls", async () => {
    const startThread = vi.fn(async () => ({ thread: { id: "t-1" } }))
    const runTextTurn = vi.fn(async (id: string, text: string) => `${id}:${text}`)
    const runtime = buildRuntime({ codex: fakeCodex({ startThread, runTextTurn }) })

    expect(await runtime.runTextTurn("k", "first")).toBe("t-1:first")
    expect(await runtime.runTextTurn("k", "second")).toBe("t-1:second")

    expect(startThread).toHaveBeenCalledTimes(1)
    expect(runTextTurn).toHaveBeenCalledTimes(2)
  })

  it("uses ONE codex thread regardless of how many threadKeys feed in", async () => {
    let starts = 0
    const runtime = buildRuntime({
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `t-${++starts}` } }),
        runTextTurn: async (id) => id,
      }),
    })

    expect(await runtime.runTextTurn("a", "x")).toBe("t-1")
    expect(await runtime.runTextTurn("b", "x")).toBe("t-1")
    expect(await runtime.runTextTurn("a", "y")).toBe("t-1")
    expect(starts).toBe(1)
  })

  it("uses a separate codex thread per threadKey in thread scope", async () => {
    let starts = 0
    const runtime = buildRuntime({
      conversationScope: "thread",
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `t-${++starts}` } }),
        runTextTurn: async (id) => id,
      }),
    })

    expect(await runtime.runTextTurn("a", "x")).toBe("t-1")
    expect(await runtime.runTextTurn("b", "x")).toBe("t-2")
    expect(await runtime.runTextTurn("a", "y")).toBe("t-1")
    expect(starts).toBe(2)
  })

  it("persists every thread-scope mapping without overwriting earlier keys", async () => {
    let starts = 0
    const setCodexThreadIds = vi.fn()
    const runtime = buildRuntime({
      conversationScope: "thread",
      projectStateStore: {
        setCodexThreadId: vi.fn(),
        setCodexThreadIds,
      },
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `t-${++starts}` } }),
      }),
    })

    await runtime.runTextTurn("a", "first")
    await runtime.runTextTurn("b", "second")

    expect(setCodexThreadIds).toHaveBeenLastCalledWith("00000000-0000-4000-8000-000000000000", {
      a: "t-1",
      b: "t-2",
    })
  })

  it("runs different threadKeys concurrently in thread scope", async () => {
    let releaseTurns: () => void = () => {}
    const turnGate = new Promise<void>((resolve) => {
      releaseTurns = resolve
    })
    let active = 0
    let maxActive = 0
    const runtime = buildRuntime({
      conversationScope: "thread",
      turnConcurrency: 2,
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await turnGate
          active -= 1
          return text
        },
      }),
    })

    const first = runtime.runTextTurn("a", "first")
    const second = runtime.runTextTurn("b", "second")
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(maxActive).toBe(2)
    releaseTurns()
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
  })

  it("serializes turns within the same thread", async () => {
    const order: string[] = []
    const runtime = buildRuntime({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          order.push(`enter:${text}`)
          await new Promise((r) => setTimeout(r, 10))
          order.push(`exit:${text}`)
          return text
        },
      }),
    })

    const p1 = runtime.runTextTurn("k", "1")
    const p2 = runtime.runTextTurn("k", "2")
    await Promise.all([p1, p2])

    expect(order).toEqual(["enter:1", "exit:1", "enter:2", "exit:2"])
  })

  it("returns underlying codex errors as Error instead of rejecting", async () => {
    const runtime = buildRuntime({
      codex: fakeCodex({
        runTextTurn: async () => new Error("turn failed"),
      }),
    })

    const result = await runtime.runTextTurn("k", "x")
    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) expect(result.message).toBe("turn failed")
  })

  it("keeps codex running after an isolated command output budget error", async () => {
    let running = true
    const calls: string[] = []
    const runtime = buildRuntime({
      codex: fakeCodex({
        isRunning: () => running,
        stop: async () => {
          calls.push("stop")
          running = false
        },
        start: async () => {
          calls.push("start")
          running = true
        },
        runTextTurn: async () => new Error("codex command output exceeded 200000 chars"),
      }),
    })

    const result = await runtime.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toBe("codex command output exceeded 200000 chars")
    }
    expect(calls).toEqual([])
  })

  it("restarts codex when a turn stops producing notifications", async () => {
    let running = true
    const calls: string[] = []
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    const runtime = buildRuntime({
      eventLog,
      turnTimeoutMs: 100,
      turnIdleTimeoutMs: 5,
      codex: fakeCodex({
        isRunning: () => running,
        stop: async () => {
          calls.push("stop")
          running = false
        },
        start: async () => {
          calls.push("start")
          running = true
        },
        runTextTurn: async () => await new Promise<string>(() => {}),
      }),
    })

    const result = await runtime.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain("codex turn idle timeout after 0.005s")
    }
    expect(calls).toEqual(["stop", "start"])
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "codex.recovery",
        project: "demo",
        status: "succeeded",
      }),
    )
  })

  it("times out and recovers when thread/start never replies", async () => {
    let running = true
    let startThreadCalls = 0
    const calls: string[] = []
    const runtime = buildRuntime({
      turnTimeoutMs: 15,
      turnIdleTimeoutMs: 15,
      codex: fakeCodex({
        isRunning: () => running,
        startThread: async () => {
          startThreadCalls += 1
          if (startThreadCalls === 1) return await new Promise<never>(() => {})
          return { thread: { id: "thread-recovered" } }
        },
        stop: async () => {
          calls.push("stop")
          running = false
        },
        start: async () => {
          calls.push("start")
          running = true
        },
      }),
    })

    const first = await runtime.runTextTurn("k", "first")
    expect(first).toBeInstanceOf(Error)
    if (first instanceof Error) {
      expect(first.message).toBe("codex turn hard deadline exceeded after 0.015s")
    }
    expect(calls).toEqual(["stop", "start"])

    await expect(runtime.runTextTurn("k", "second")).resolves.toBe("echo:second")
  })

  it("times out and recovers when thread/resume never replies", async () => {
    let running = true
    let resumeCalls = 0
    const calls: string[] = []
    const runtime = buildRuntime({
      initialCodexThreadId: "thread-existing",
      turnTimeoutMs: 15,
      turnIdleTimeoutMs: 15,
      codex: fakeCodex({
        isRunning: () => running,
        resumeThread: async (params) => {
          resumeCalls += 1
          if (resumeCalls === 1) return await new Promise<never>(() => {})
          return { thread: { id: params.threadId } }
        },
        stop: async () => {
          calls.push("stop")
          running = false
        },
        start: async () => {
          calls.push("start")
          running = true
        },
      }),
    })

    const first = await runtime.runTextTurn("k", "first")
    expect(first).toBeInstanceOf(Error)
    expect(calls).toEqual(["stop", "start"])
    await expect(runtime.runTextTurn("k", "second")).resolves.toBe("echo:second")
  })

  it("records recovery failure when the old codex child survives stop", async () => {
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    const start = vi.fn(async () => undefined)
    const runtime = buildRuntime({
      eventLog,
      codex: fakeCodex({
        isRunning: () => true,
        stop: async () => undefined,
        start,
        runTextTurn: async () => new Error("codex app-server exited (code 1)"),
      }),
    })

    const result = await runtime.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    expect(start).not.toHaveBeenCalled()
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "codex.recovery",
        status: "failed",
        error: expect.stringContaining("after stop completed"),
      }),
    )
  })

  it("keeps the hard turn deadline even when the idle deadline is longer", async () => {
    let running = true
    const calls: string[] = []
    const runtime = buildRuntime({
      turnTimeoutMs: 5,
      turnIdleTimeoutMs: 100,
      codex: fakeCodex({
        isRunning: () => running,
        stop: async () => {
          calls.push("stop")
          running = false
        },
        start: async () => {
          calls.push("start")
          running = true
        },
        runTextTurn: async () => await new Promise<string>(() => {}),
      }),
    })

    const result = await runtime.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toBe("codex turn hard deadline exceeded after 0.005s")
    }
    expect(calls).toEqual(["stop", "start"])
  })

  it("keeps an active turn alive while codex notifications continue", async () => {
    let notify: ((method: string) => void) | undefined
    let finish: ((reply: string) => void) | undefined
    const runtime = buildRuntime({
      turnTimeoutMs: 1_000,
      turnIdleTimeoutMs: 30,
      codex: fakeCodex({
        runTextTurn: async (_threadId, _text, options) =>
          await new Promise<string>((resolve) => {
            notify = typeof options === "string" ? undefined : options?.onActivity
            finish = resolve
          }),
      }),
    })

    const resultPromise = runtime.runTextTurn("k", "x")
    await new Promise((resolve) => setTimeout(resolve, 20))
    notify?.("item/started")
    await new Promise((resolve) => setTimeout(resolve, 20))
    notify?.("item/commandExecution/outputDelta")
    await new Promise((resolve) => setTimeout(resolve, 20))
    finish?.("ok")

    await expect(resultPromise).resolves.toBe("ok")
  })

  it("bounds persisted turn input and reply diagnostics", async () => {
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    const large = "x".repeat(20_000)
    const runtime = buildRuntime({
      eventLog,
      codex: fakeCodex({
        runTextTurn: async () => large,
      }),
    })

    await expect(runtime.runTextTurn("thread", large)).resolves.toBe(large)

    const start = events().find((event) => event.type === "turn.start")
    const complete = events().find((event) => event.type === "turn.complete")
    if (start?.type !== "turn.start" || complete?.type !== "turn.complete") {
      throw new Error("expected turn lifecycle events")
    }
    expect(start.input.length).toBeLessThanOrEqual(16_000)
    expect(complete.reply.length).toBeLessThanOrEqual(16_000)
    expect(start.input).toContain("[20000 chars]")
    expect(complete.reply).toContain("[20000 chars]")
  })

  it("keeps queued messages as separate turns", async () => {
    let releaseFirstTurn: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const calls: string[] = []
    const runtime = buildRuntime({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          calls.push(text)
          if (calls.length === 1) await firstTurnGate
          return text
        },
      }),
    })

    const p1 = runtime.runTextTurn("k", "1")
    // Let the first turn enter the gated codex.runTextTurn before queueing more.
    await new Promise((r) => setTimeout(r, 5))

    const p2 = runtime.runTextTurn("k", "2")
    const p3 = runtime.runTextTurn("k", "3")
    releaseFirstTurn()

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(calls).toEqual(["1", "2", "3"])
    expect(r1).toBe("1")
    expect(r2).toBe("2")
    expect(r3).toBe("3")
  })

  it("rejects queued work at the item limit without retaining it", async () => {
    let releaseFirstTurn: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    let calls = 0
    const runtime = buildRuntime({
      eventLog,
      turnQueueMaxItems: 1,
      turnQueueMaxBytes: 1_024,
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          calls += 1
          if (calls === 1) await firstTurnGate
          return text
        },
      }),
    })

    const first = runtime.runTextTurn("k", "first")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const queued = runtime.runTextTurn("k", "queued")
    const rejected = await runtime.runTextTurn("k", "rejected")

    expect(rejected).toBeInstanceOf(Error)
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "turn.rejected",
        queueDepth: 1,
      }),
    )

    releaseFirstTurn()
    await expect(first).resolves.toBe("first")
    await expect(queued).resolves.toBe("queued")
  })

  it("rejects a single turn larger than the byte budget", async () => {
    const runTextTurn = vi.fn(async () => "unexpected")
    const runtime = buildRuntime({
      turnQueueMaxBytes: 4,
      codex: fakeCodex({ runTextTurn }),
    })

    const result = await runtime.runTextTurn("k", "ああ")

    expect(result).toBeInstanceOf(Error)
    expect(runTextTurn).not.toHaveBeenCalled()
  })

  it("records queue depth, wait time, duration, and completion in logs and events", async () => {
    let releaseFirstTurn: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const logs: string[] = []
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    let attempts = 0
    const runtime = buildRuntime({
      eventLog,
      onLog: (line) => logs.push(line),
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          attempts += 1
          if (attempts === 1) await firstTurnGate
          return text
        },
      }),
    })

    const first = runtime.runTextTurn("k", "first")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = runtime.runTextTurn("k", "second")
    releaseFirstTurn()
    await Promise.all([first, second])

    expect(logs.some((line) => line.includes("turn queued (pending=1)"))).toBe(true)
    expect(logs.some((line) => line.includes("turn complete duration="))).toBe(true)
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "turn.queued",
        project: "demo",
        queueDepth: 1,
      }),
    )
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "turn.complete",
        project: "demo",
        durationMs: expect.any(Number),
        queueWaitMs: expect.any(Number),
      }),
    )
  })

  it("recovers a failed turn so the next turn in the same thread still runs", async () => {
    let attempt = 0
    const runtime = buildRuntime({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          attempt += 1
          if (attempt === 1) return new Error("first fails")
          return text
        },
      }),
    })

    const first = await runtime.runTextTurn("k", "1")
    expect(first).toBeInstanceOf(Error)
    if (first instanceof Error) expect(first.message).toBe("first fails")
    await expect(runtime.runTextTurn("k", "2")).resolves.toBe("2")
  })
})

describe("LeucoProjectRuntime turn timeouts", () => {
  it("interrupts only the timed-out thread and lets a concurrent sibling finish", async () => {
    vi.useFakeTimers()
    try {
      const stop = vi.fn(async () => undefined)
      const start = vi.fn(async () => undefined)
      const pendingTurns = new Map<string, (result: string | Error) => void>()
      const interruptTurn = vi.fn<CodexClientPort["interruptTurn"]>(async (threadId) => {
        const settle = pendingTurns.get(threadId)
        if (settle === undefined) return { status: "not-active" }
        settle(new Error(`codex turn turn-${threadId} interrupted`))
        return { status: "requested", turnId: `turn-${threadId}` }
      })
      const runtime = buildRuntime({
        conversationScope: "thread",
        turnConcurrency: 2,
        turnTimeoutMs: 1_000,
        turnIdleTimeoutMs: 20,
        codex: fakeCodex({
          start,
          stop,
          interruptTurn,
          runTextTurn: (threadId, text) =>
            new Promise<string | Error>((resolve) => {
              if (text === "stuck") {
                pendingTurns.set(threadId, resolve)
                return
              }
              setTimeout(() => resolve("sibling survived"), 10)
            }),
        }),
      })

      const stuck = runtime.runTextTurn("slack:A", "stuck")
      const sibling = runtime.runTextTurn("slack:B", "normal")
      await vi.advanceTimersByTimeAsync(20)

      const [stuckResult, siblingResult] = await Promise.all([stuck, sibling])
      expect(stuckResult).toBeInstanceOf(Error)
      if (stuckResult instanceof Error) expect(stuckResult.message).toContain("idle timeout")
      expect(siblingResult).toBe("sibling survived")
      expect(interruptTurn).toHaveBeenCalledTimes(1)
      expect(stop).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("restarts Codex after the idle deadline passes without activity", async () => {
    vi.useFakeTimers()
    try {
      let isRunning = false
      const start = vi.fn(async () => {
        isRunning = true
      })
      const stop = vi.fn(async () => {
        isRunning = false
      })
      const codex = fakeCodex({
        start,
        stop,
        isRunning: () => isRunning,
        runTextTurn: () => new Promise<string | Error>(() => {}),
      })
      const runtime = buildRuntime({
        codex,
        turnTimeoutMs: 1_000,
        turnIdleTimeoutMs: 20,
      })
      await runtime.start()

      const turn = runtime.runTextTurn("thread", "silent")
      await vi.advanceTimersByTimeAsync(20)
      const reply = await turn

      expect(reply).toBeInstanceOf(Error)
      if (reply instanceof Error) expect(reply.message).toContain("idle timeout")
      expect(stop).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("renews the idle deadline whenever the active Codex turn reports activity", async () => {
    vi.useFakeTimers()
    try {
      const activityCallbacks: Array<(method: string) => void> = []
      let resolveTurn: (reply: string | Error) => void = () => {}
      const stop = vi.fn(async () => undefined)
      const runTextTurn = vi.fn<CodexClientPort["runTextTurn"]>((_threadId, _text, options) => {
        if (typeof options !== "string" && options?.onActivity) {
          activityCallbacks.push(options.onActivity)
        }
        return new Promise<string | Error>((resolve) => {
          resolveTurn = resolve
        })
      })
      const runtime = buildRuntime({
        codex: fakeCodex({ stop, runTextTurn }),
        turnTimeoutMs: 1_000,
        turnIdleTimeoutMs: 20,
      })

      const turn = runtime.runTextTurn("thread", "active")
      await vi.advanceTimersByTimeAsync(0)
      const onActivity = activityCallbacks[0]
      if (!onActivity) throw new Error("Codex activity callback was not provided")

      await vi.advanceTimersByTimeAsync(15)
      onActivity("item/started")
      await vi.advanceTimersByTimeAsync(15)
      onActivity("item/commandExecution/outputDelta")
      await vi.advanceTimersByTimeAsync(15)
      resolveTurn("ok")

      await expect(turn).resolves.toBe("ok")
      expect(stop).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(["start", "resume"])(
    "includes thread %s in the hard turn deadline",
    async (threadAction) => {
      vi.useFakeTimers()
      try {
        let isRunning = false
        const start = vi.fn(async () => {
          isRunning = true
        })
        const stop = vi.fn(async () => {
          isRunning = false
        })
        const startThread = vi.fn<CodexClientPort["startThread"]>(() =>
          threadAction === "start"
            ? new Promise(() => {})
            : Promise.resolve({ thread: { id: "new-thread" } }),
        )
        const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(() =>
          threadAction === "resume"
            ? new Promise(() => {})
            : Promise.resolve({ thread: { id: "saved-thread" } }),
        )
        const runTextTurn = vi.fn<CodexClientPort["runTextTurn"]>(async () => "unreachable")
        const codex = fakeCodex({
          start,
          stop,
          isRunning: () => isRunning,
          startThread,
          resumeThread,
          runTextTurn,
        })
        const runtime = buildRuntime({
          codex,
          initialCodexThreadId: threadAction === "resume" ? "saved-thread" : undefined,
          turnTimeoutMs: 20,
          turnIdleTimeoutMs: 1_000,
        })
        await runtime.start()

        const turn = runtime.runTextTurn("thread", "blocked setup")
        await vi.advanceTimersByTimeAsync(20)
        const reply = await turn

        expect(reply).toBeInstanceOf(Error)
        if (reply instanceof Error) expect(reply.message).toContain("hard deadline")
        expect(runTextTurn).not.toHaveBeenCalled()
        expect(stop).toHaveBeenCalledTimes(1)
        expect(start).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    },
  )
})

describe("LeucoProjectRuntime Codex child recovery", () => {
  it("keeps the shared child and live thread after an isolated command output overflow", async () => {
    const reason = "codex command output exceeded 200000 chars from call_12345"
    const logs: string[] = []
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    const stop = vi.fn(async () => undefined)
    const start = vi.fn(async () => undefined)
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "preserved-thread" },
    }))
    const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(async (params) => ({
      thread: { id: params.threadId },
    }))
    let turnCount = 0
    const runTextTurn = vi.fn<CodexClientPort["runTextTurn"]>(async () => {
      turnCount += 1
      return turnCount === 1 ? new Error(reason) : "ok"
    })
    const runtime = buildRuntime({
      eventLog,
      onLog: (line) => logs.push(line),
      codex: fakeCodex({
        start,
        stop,
        startThread,
        resumeThread,
        runTextTurn,
      }),
    })

    const failed = await runtime.runTextTurn("thread", "first")
    expect(failed).toEqual(new Error(reason))
    expect(stop).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(runtime.listThreads()).toEqual([
      { threadKey: runtime.projectName, threadId: "preserved-thread" },
    ])
    expect(events().some((event) => event.type === "codex.recovery")).toBe(false)
    expect(logs.some((line) => line.includes("command output overflow isolated"))).toBe(true)

    await expect(runtime.runTextTurn("thread", "second")).resolves.toBe("ok")
    expect(runTextTurn).toHaveBeenCalledTimes(2)
    expect(startThread).toHaveBeenCalledTimes(1)
    expect(resumeThread).not.toHaveBeenCalled()
  })

  it("restarts the child only when turn-level interruption fails", async () => {
    const reason =
      'codex turn interrupt failed while handling "codex command output exceeded 200000 chars from call_failed": interrupt rejected'
    const logs: string[] = []
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    let isRunning = true
    const runtime = buildRuntime({
      eventLog,
      onLog: (line) => logs.push(line),
      codex: fakeCodex({
        isRunning: () => isRunning,
        stop: async () => {
          isRunning = false
        },
        start: async () => {
          throw new Error("spawn failed")
        },
        runTextTurn: async () => new Error(reason),
      }),
    })

    const reply = await runtime.runTextTurn("thread", "first")

    expect(reply).toEqual(new Error(reason))
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "codex.recovery",
        reason,
        status: "failed",
        error: "spawn failed",
      }),
    )
    expect(logs.some((line) => line.includes("codex recovery failed"))).toBe(true)
  })

  it("discards a thread only when the same overflow call repeats after isolation", async () => {
    const reason =
      "turn failed: codex command output exceeded 200000 chars from exec-b7c29f6c-a749-4ea8-974f-e7a60c60ec89"
    let isRunning = true
    let turnCount = 0
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "fresh-thread" },
    }))
    const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(async (params) => ({
      thread: { id: params.threadId },
    }))
    const runtime = buildRuntime({
      initialCodexThreadId: "saved-thread",
      codex: fakeCodex({
        isRunning: () => isRunning,
        start: async () => {
          isRunning = true
        },
        stop: async () => {
          isRunning = false
        },
        startThread,
        resumeThread,
        runTextTurn: async () => {
          turnCount += 1
          return turnCount <= 2 ? new Error(reason) : "ok"
        },
      }),
    })

    await expect(runtime.runTextTurn("thread", "first")).resolves.toEqual(new Error(reason))
    expect(runtime.listThreads()).toEqual([
      { threadKey: runtime.projectName, threadId: "saved-thread" },
    ])

    await expect(runtime.runTextTurn("thread", "second")).resolves.toEqual(new Error(reason))
    expect(runtime.listThreads()).toEqual([])

    await expect(runtime.runTextTurn("thread", "third")).resolves.toBe("ok")
    expect(resumeThread).toHaveBeenCalledTimes(1)
    expect(startThread).toHaveBeenCalledTimes(1)
  })
})

describe("LeucoProjectRuntime queue admission", () => {
  it("admits 64 queued turns and rejects the next one with a structured event", async () => {
    let releaseFirstTurn: () => void = () => {}
    let reportFirstTurnEntered: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const firstTurnEntered = new Promise<void>((resolve) => {
      reportFirstTurnEntered = resolve
    })
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    let callCount = 0
    const runtime = buildRuntime({
      eventLog,
      codex: fakeCodex({
        runTextTurn: async (_threadId, text) => {
          callCount += 1
          if (callCount === 1) {
            reportFirstTurnEntered()
            await firstTurnGate
          }
          return text
        },
      }),
    })

    const first = runtime.runTextTurn("thread", "first")
    await firstTurnEntered
    const queued = Array.from({ length: 64 }, (_unused, index) =>
      runtime.runTextTurn("thread", String(index)),
    )

    const rejected = await runtime.runTextTurn("thread", "overflow")
    expect(rejected).toBeInstanceOf(Error)
    if (rejected instanceof Error) expect(rejected.message).toContain("64 pending")

    const event = events().find((candidate) => candidate.type === "turn.rejected")
    expect(event).toMatchObject({
      type: "turn.rejected",
      reason: "queue_count_limit",
      queueDepth: 64,
      maxQueueDepth: 64,
      inputBytes: 8,
    })

    releaseFirstTurn()
    await first
    await Promise.all(queued)
  })

  it("admits addressed work ahead of a queue filled by normal turns", async () => {
    let releaseFirstTurn: () => void = () => {}
    let reportFirstTurnEntered: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const firstTurnEntered = new Promise<void>((resolve) => {
      reportFirstTurnEntered = resolve
    })
    const executionOrder: string[] = []
    let callCount = 0
    const runtime = buildRuntime({
      codex: fakeCodex({
        runTextTurn: async (_threadId, text) => {
          callCount += 1
          executionOrder.push(text)
          if (callCount === 1) {
            reportFirstTurnEntered()
            await firstTurnGate
          }
          return text
        },
      }),
    })

    const first = runtime.runTextTurn("thread", "first")
    await firstTurnEntered
    const normal = Array.from({ length: 64 }, (_unused, index) =>
      runtime.runTextTurn("thread", `normal-${index}`),
    )
    const addressed = runtime.runTextTurn("mention", "addressed", { priority: "high" })

    releaseFirstTurn()
    await expect(first).resolves.toBe("first")
    await expect(addressed).resolves.toBe("addressed")
    const normalResults = await Promise.all(normal)

    expect(executionOrder.slice(0, 2)).toEqual(["first", "addressed"])
    expect(normalResults.filter((result) => result instanceof Error)).toHaveLength(1)
  })

  it("counts UTF-8 bytes against an injectable byte limit", async () => {
    let releaseFirstTurn: () => void = () => {}
    let reportFirstTurnEntered: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const firstTurnEntered = new Promise<void>((resolve) => {
      reportFirstTurnEntered = resolve
    })
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    let callCount = 0
    const runtime = buildRuntime({
      eventLog,
      turnQueueMaxBytes: 5,
      codex: fakeCodex({
        runTextTurn: async (_threadId, text) => {
          callCount += 1
          if (callCount === 1) {
            reportFirstTurnEntered()
            await firstTurnGate
          }
          return text
        },
      }),
    })

    const first = runtime.runTextTurn("thread", "first")
    await firstTurnEntered
    const admitted = runtime.runTextTurn("thread", "あ")
    const rejected = await runtime.runTextTurn("thread", "い")

    expect(rejected).toBeInstanceOf(Error)
    if (rejected instanceof Error) expect(rejected.message).toContain("5 UTF-8 bytes")
    const event = events().find((candidate) => candidate.type === "turn.rejected")
    expect(event).toMatchObject({
      type: "turn.rejected",
      reason: "queue_bytes_limit",
      queueDepth: 1,
      queueBytes: 3,
      inputBytes: 3,
      maxQueueBytes: 5,
    })

    releaseFirstTurn()
    await expect(first).resolves.toBe("first")
    await expect(admitted).resolves.toBe("あ")
  })

  it("rejects new work immediately after the runtime has stopped", async () => {
    const eventLog = new LeucoEventLog()
    const events = () => eventLog.query().map((entry) => entry.event)
    const runTextTurn = vi.fn<CodexClientPort["runTextTurn"]>(async () => "unexpected")
    const runtime = buildRuntime({ eventLog, codex: fakeCodex({ runTextTurn }) })
    await runtime.stop()

    const reply = await runtime.runTextTurn("thread", "late")

    expect(reply).toBeInstanceOf(Error)
    expect(runTextTurn).not.toHaveBeenCalled()
    expect(events()).toContainEqual(
      expect.objectContaining({
        type: "turn.rejected",
        reason: "runtime_stopped",
        queueDepth: 0,
      }),
    )
  })
})

describe("LeucoProjectRuntime corrupt history recovery", () => {
  it("discards corrupt persisted history and starts a fresh thread for the same turn", async () => {
    const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(
      async () =>
        new Error(
          "[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long",
        ),
    )
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "fresh-thread" },
    }))
    const runTextTurn = vi.fn<CodexClientPort["runTextTurn"]>(async (threadId) => threadId)
    const runtime = buildRuntime({
      initialCodexThreadId: "corrupt-thread",
      codex: fakeCodex({ resumeThread, startThread, runTextTurn }),
    })

    await expect(runtime.runTextTurn("thread", "hello")).resolves.toBe("fresh-thread")
    expect(resumeThread).toHaveBeenCalledTimes(1)
    expect(startThread).toHaveBeenCalledTimes(1)
    expect(runtime.listThreads()).toEqual([
      { threadKey: runtime.projectName, threadId: "fresh-thread" },
    ])
  })

  it("keeps persisted history on authentication and network failures", async () => {
    const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(
      async () => new Error("authentication failed: network connection reset"),
    )
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "unexpected" },
    }))
    const runtime = buildRuntime({
      initialCodexThreadId: "saved-thread",
      codex: fakeCodex({ resumeThread, startThread }),
    })

    const first = await runtime.runTextTurn("thread", "first")
    const second = await runtime.runTextTurn("thread", "second")

    expect(first).toBeInstanceOf(Error)
    expect(second).toBeInstanceOf(Error)
    expect(resumeThread).toHaveBeenCalledTimes(2)
    expect(startThread).not.toHaveBeenCalled()
    expect(runtime.listThreads()).toEqual([
      { threadKey: runtime.projectName, threadId: "saved-thread" },
    ])
  })

  it("clears a thread when corruption is discovered while running a turn", async () => {
    const startThread = vi
      .fn<CodexClientPort["startThread"]>()
      .mockResolvedValueOnce({ thread: { id: "corrupt-thread" } })
      .mockResolvedValueOnce({ thread: { id: "fresh-thread" } })
    const runTextTurn = vi
      .fn<CodexClientPort["runTextTurn"]>()
      .mockResolvedValueOnce(
        new Error(
          "[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long",
        ),
      )
      .mockResolvedValueOnce("ok")
    const runtime = buildRuntime({ codex: fakeCodex({ startThread, runTextTurn }) })

    const failed = await runtime.runTextTurn("thread", "first")

    expect(failed).toEqual(
      new Error("codex session history was corrupted and has been reset; please resend"),
    )
    expect(runtime.listThreads()).toEqual([])
    await expect(runtime.runTextTurn("thread", "second")).resolves.toBe("ok")
    expect(startThread).toHaveBeenCalledTimes(2)
    expect(runtime.listThreads()).toEqual([
      { threadKey: runtime.projectName, threadId: "fresh-thread" },
    ])
  })
})

describe("LeucoProjectRuntime introspection", () => {
  it("listConnectors returns connector names", () => {
    const runtime = buildRuntime({ connectors: [fakeConnector("one"), fakeConnector("two")] })
    expect(runtime.listConnectors()).toEqual(["one", "two"])
  })

  it("key returns the project name", () => {
    const runtime = new LeucoProjectRuntime({
      projectId: "00000000-0000-4000-8000-000000000000",
      projectName: "p",
      projectPath: "/tmp/p",
      codex: fakeCodex(),
      connectors: [],
      onLog: () => {},
    })
    expect(runtime.projectName).toBe("p")
  })

  it("listThreads exposes the agent's single codex thread once a turn has run", async () => {
    const runtime = buildRuntime({
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: "tx" } }),
        runTextTurn: async () => "ok",
      }),
    })

    await runtime.runTextTurn("k1", "hi")
    expect(runtime.listThreads()).toEqual([{ threadKey: runtime.projectName, threadId: "tx" }])

    expect(runtime.clearThread(runtime.projectName)).toBe(true)
    expect(runtime.listThreads()).toEqual([])
    expect(runtime.clearThread(runtime.projectName)).toBe(false)
  })

  it("lists and clears independent thread-scope mappings", async () => {
    let starts = 0
    const runtime = buildRuntime({
      conversationScope: "thread",
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `tx-${++starts}` } }),
        runTextTurn: async () => "ok",
      }),
    })

    await runtime.runTextTurn("slack:C1:T1", "one")
    await runtime.runTextTurn("slack:C1:T2", "two")
    expect(runtime.listThreads()).toEqual([
      { threadKey: "slack:C1:T1", threadId: "tx-1" },
      { threadKey: "slack:C1:T2", threadId: "tx-2" },
    ])

    expect(runtime.clearThread("tx-1")).toBe(true)
    expect(runtime.listThreads()).toEqual([{ threadKey: "slack:C1:T2", threadId: "tx-2" }])
  })

  it("isCodexRunning delegates to the codex port", () => {
    const runtime = buildRuntime({ codex: fakeCodex({ isRunning: () => false }) })
    expect(runtime.isCodexRunning()).toBe(false)
  })

  it("clears a corrupt codex history so the next turn starts a fresh thread", async () => {
    const startThread = vi
      .fn<CodexClientPort["startThread"]>()
      .mockResolvedValueOnce({ thread: { id: "corrupt-thread" } })
      .mockResolvedValueOnce({ thread: { id: "fresh-thread" } })
    const runTextTurn = vi
      .fn<CodexClientPort["runTextTurn"]>()
      .mockResolvedValueOnce(
        new Error(
          "[ObjectParam] [input[381].arguments.bad] invalid_request_error: property name is too long",
        ),
      )
      .mockResolvedValueOnce("ok")
    const runtime = buildRuntime({ codex: fakeCodex({ startThread, runTextTurn }) })

    const failed = await runtime.runTextTurn("k", "first")

    expect(failed).toEqual(
      new Error("codex session history was corrupted and has been reset; please resend"),
    )
    expect(runtime.listThreads()).toEqual([])

    await expect(runtime.runTextTurn("k", "second")).resolves.toBe("ok")
    expect(startThread).toHaveBeenCalledTimes(2)
    expect(runtime.listThreads()).toEqual([
      { threadKey: runtime.projectName, threadId: "fresh-thread" },
    ])
  })
})

describe("LeucoProjectRuntime developer instructions", () => {
  it("prepends the dynamic preamble by default and folds in channel identities", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const runtime = buildRuntime({
      codex: fakeCodex({ startThread }),
      connectors: [fakeConnector("general", { botUserId: "U777" })],
      agentSpec: { developerInstructions: "you are mochi" },
    })

    await runtime.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toContain("# leuco built-in instructions")
    expect(arg.developerInstructions).toContain("`U777`")
    expect(arg.developerInstructions).toContain("`/tmp/leuco/demo/.codex/AGENTS.md`")
    expect(arg.developerInstructions).not.toContain("Machine-local time zone")
    expect(arg.developerInstructions).not.toContain(".codex/agents")
    expect(arg.developerInstructions).toContain("\n---\n\nyou are mochi")
  })

  it("passes the per-agent instructions verbatim when useCommonInstructions=false", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const runtime = buildRuntime({
      codex: fakeCodex({ startThread }),
      connectors: [fakeConnector("general", { botUserId: "U777" })],
      agentSpec: { developerInstructions: "raw instructions only" },
      useCommonInstructions: false,
    })

    await runtime.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toBe("raw instructions only")
  })

  it("omits developer instructions entirely when neither preamble nor per-agent text is configured", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const runtime = buildRuntime({
      codex: fakeCodex({ startThread }),
      useCommonInstructions: false,
    })

    await runtime.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toBeUndefined()
  })

  it("splices configured presets between the preamble and the per-agent tail", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const runtime = buildRuntime({
      codex: fakeCodex({ startThread }),
      agentSpec: { developerInstructions: "you are mochi" },
      presets: ["# Friendly\nbe warm"],
    })

    await runtime.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    const out = arg.developerInstructions ?? ""
    const preambleAt = out.indexOf("# leuco built-in instructions")
    const presetAt = out.indexOf("# Friendly")
    const tailAt = out.indexOf("you are mochi")
    expect(preambleAt).toBeGreaterThanOrEqual(0)
    expect(preambleAt).toBeLessThan(presetAt)
    expect(presetAt).toBeLessThan(tailAt)
  })

  it("emits presets only (no preamble) when useCommonInstructions=false but presets are set", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const runtime = buildRuntime({
      codex: fakeCodex({ startThread }),
      useCommonInstructions: false,
      presets: ["# Friendly\nbe warm"],
      agentSpec: { developerInstructions: "tail" },
    })

    await runtime.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toBe("# Friendly\nbe warm\n\n---\n\ntail")
  })
})

describe("LeucoProjectRuntime.stop with queued turns", () => {
  it("cancels queued turns and never respawns codex after stop", async () => {
    const starts: number[] = []
    let running = false
    let releaseTurn: (value: string) => void = () => {}
    const codex = fakeCodex({
      start: async () => {
        starts.push(1)
        running = true
      },
      stop: async () => {
        running = false
      },
      isRunning: () => running,
      runTextTurn: () =>
        new Promise<string>((resolve) => {
          releaseTurn = resolve
        }),
    })

    const runtime = buildRuntime({ codex })
    await runtime.start()

    const first = runtime.runTextTurn("thread", "one")
    const second = runtime.runTextTurn("thread", "two")

    const stopPromise = runtime.stop()
    const secondReply = await second
    expect(secondReply).toBeInstanceOf(Error)

    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseTurn("done")

    await stopPromise
    const firstReply = await first
    expect(firstReply).toBe("done")

    // exactly the one spawn from runtime.start(); the drained queue must not
    // have respawned the codex child after stop() killed it
    expect(starts).toHaveLength(1)

    const third = await runtime.runTextTurn("thread", "three")
    expect(third).toBeInstanceOf(Error)
  })

  it("stops Codex while a schedule connector drains its in-flight turn", async () => {
    const entry: ScheduleEntry = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      name: "due",
      runAt: "2026-05-07T09:00:00Z",
      prompt: "run",
      enabled: true,
    }
    const storeMutations = { marks: 0, removes: 0 }
    const store: ScheduleStorePort = {
      listEntries: () => [entry],
      getLastFiredAt: () => null,
      markFired: () => {
        storeMutations.marks += 1
      },
      removeEntry: () => {
        storeMutations.removes += 1
      },
    }
    const schedule = new LeucoScheduleConnector({
      name: "schedule",
      store,
      now: () => new Date("2026-05-07T09:01:00Z"),
      intervalMs: 60 * 60 * 1000,
    })
    const turnResolvers: Array<(reply: string | Error) => void> = []
    let reportTurnStarted: () => void = () => {}
    const turnStarted = new Promise<void>((resolve) => {
      reportTurnStarted = resolve
    })
    const stop = vi.fn(async () => {
      const resolveTurn = turnResolvers[0]
      if (resolveTurn) resolveTurn(new Error("codex stopped"))
    })
    const codex = fakeCodex({
      stop,
      runTextTurn: () =>
        new Promise<string | Error>((resolve) => {
          turnResolvers.push(resolve)
          reportTurnStarted()
        }),
    })
    const runtime = buildRuntime({ codex, connectors: [schedule] })
    await runtime.start()
    await turnStarted

    await runtime.stop()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(storeMutations).toEqual({ marks: 0, removes: 0 })
    await Promise.resolve()
    expect(storeMutations).toEqual({ marks: 0, removes: 0 })
  })
})
