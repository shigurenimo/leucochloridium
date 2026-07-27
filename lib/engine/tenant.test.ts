import { describe, expect, it, vi } from "vitest"
import type {
  ChannelIdentity,
  ChannelPlugin,
  ChannelPluginContext,
} from "@/channels/channel-plugin"
import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import type { ConversationScope, ScheduleEntry } from "@/config/config-schema"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoTenant } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoEvent } from "@/events/leuco-event-types"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"

const fakeCodex = (overrides: Partial<CodexClientPort> = {}): CodexClientPort => ({
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: () => true,
  startThread: async () => ({ thread: { id: `thread-${Math.random()}` } }),
  resumeThread: async (params) => ({ thread: { id: params.threadId } }),
  runTextTurn: async (_id, text) => `echo:${text}`,
  ...overrides,
})

const fakePlugin = (
  name: string,
  identity?: Partial<ChannelIdentity>,
): ChannelPlugin & { ctx: ChannelPluginContext | null } => {
  const plugin: ChannelPlugin & { ctx: ChannelPluginContext | null } = {
    name,
    ctx: null,
    async start(ctx) {
      plugin.ctx = ctx
    },
    async stop() {
      plugin.ctx = null
    },
    getIdentity: () => ({ name, type: "slack", botUserId: null, ...identity }),
  }
  return plugin
}

type BuildOverrides = {
  codex?: CodexClientPort
  plugins?: ChannelPlugin[]
  agentSpec?: { developerInstructions?: string; model?: string }
  initialCodexThreadId?: string
  useCommonInstructions?: boolean
  presets?: string[]
  onLog?: (line: string) => void
  bus?: LeucoEventBus
  turnTimeoutMs?: number
  turnIdleTimeoutMs?: number
  turnConcurrency?: number
  turnQueueMaxItems?: number
  turnQueueMaxBytes?: number
  conversationScope?: ConversationScope
  initialCodexThreadIds?: Readonly<Record<string, string>>
  projectStateStore?: Pick<LeucoProjectStateStore, "setCodexThreadId" | "setCodexThreadIds">
}

const buildTenant = (overrides: BuildOverrides = {}) =>
  new LeucoTenant({
    projectId: "00000000-0000-4000-8000-000000000000",
    projectName: "demo",
    projectPath: "/tmp/demo",
    codexHome: "/tmp/leuco/demo/.codex",
    timeZone: "Asia/Tokyo",
    codex: overrides.codex ?? fakeCodex(),
    plugins: overrides.plugins ?? [],
    agentSpec: overrides.agentSpec,
    initialCodexThreadId: overrides.initialCodexThreadId,
    useCommonInstructions: overrides.useCommonInstructions,
    presets: overrides.presets,
    onLog: overrides.onLog ?? (() => {}),
    bus: overrides.bus,
    conversationScope: overrides.conversationScope,
    turnTimeoutMs: overrides.turnTimeoutMs,
    turnIdleTimeoutMs: overrides.turnIdleTimeoutMs,
    turnConcurrency: overrides.turnConcurrency,
    turnQueueMaxItems: overrides.turnQueueMaxItems,
    turnQueueMaxBytes: overrides.turnQueueMaxBytes,
    initialCodexThreadIds: overrides.initialCodexThreadIds,
    projectStateStore: overrides.projectStateStore,
  })

describe("LeucoTenant.start / stop", () => {
  it("starts codex first, then each plugin", async () => {
    const calls: string[] = []
    const codex = fakeCodex({
      start: async () => {
        calls.push("codex.start")
      },
    })
    const a = fakePlugin("a")
    const b = fakePlugin("b")
    a.start = async () => {
      calls.push("a.start")
    }
    b.start = async () => {
      calls.push("b.start")
    }

    await buildTenant({ codex, plugins: [a, b] }).start()

    expect(calls).toEqual(["codex.start", "a.start", "b.start"])
  })

  it("stops plugins, then codex", async () => {
    const calls: string[] = []
    const codex = fakeCodex({
      stop: async () => {
        calls.push("codex.stop")
      },
    })
    const a = fakePlugin("a")
    a.stop = async () => {
      calls.push("a.stop")
    }

    const tenant = buildTenant({ codex, plugins: [a] })
    await tenant.start()
    await tenant.stop()

    expect(calls).toEqual(["a.stop", "codex.stop"])
  })

  it("stops codex before waiting for an in-flight plugin turn to settle", async () => {
    let releasePluginStop: (() => void) | null = null
    const pluginStopGate = new Promise<void>((resolve) => {
      releasePluginStop = resolve
    })
    const calls: string[] = []
    const plugin = fakePlugin("schedule")
    plugin.stop = async () => {
      calls.push("plugin.stop.begin")
      await pluginStopGate
      calls.push("plugin.stop.end")
    }
    const codex = fakeCodex({
      stop: async () => {
        calls.push("codex.stop")
        if (releasePluginStop !== null) releasePluginStop()
      },
    })
    const tenant = buildTenant({ codex, plugins: [plugin] })

    await tenant.start()
    await tenant.stop()

    expect(calls).toEqual(["plugin.stop.begin", "codex.stop", "plugin.stop.end"])
  })

  it("still stops codex when a plugin throws synchronously during shutdown", async () => {
    const calls: string[] = []
    const plugin = fakePlugin("broken")
    plugin.stop = () => {
      throw new Error("stop failed")
    }
    const tenant = buildTenant({
      codex: fakeCodex({
        stop: async () => {
          calls.push("codex.stop")
        },
      }),
      plugins: [plugin],
    })

    await tenant.start()
    await tenant.stop()

    expect(calls).toEqual(["codex.stop"])
  })

  it("rolls back codex and earlier plugins when a later plugin start fails", async () => {
    const calls: string[] = []
    const codex = fakeCodex({
      start: async () => {
        calls.push("codex.start")
      },
      stop: async () => {
        calls.push("codex.stop")
      },
    })
    const a = fakePlugin("a")
    a.start = async () => {
      calls.push("a.start")
    }
    a.stop = async () => {
      calls.push("a.stop")
    }
    const b = fakePlugin("b")
    b.start = async () => {
      calls.push("b.start")
      throw new Error("b boom")
    }
    b.stop = async () => {
      calls.push("b.stop")
    }

    const tenant = buildTenant({ codex, plugins: [a, b] })
    await expect(tenant.start()).rejects.toThrow("b boom")

    // a started, b threw mid-start, rollback stops a in reverse + codex.
    expect(calls).toEqual(["codex.start", "a.start", "b.start", "a.stop", "codex.stop"])
  })

  it("settles queued turns while stopping", async () => {
    let finishActive: (() => void) | undefined
    const tenant = buildTenant({
      codex: fakeCodex({
        stop: async () => finishActive?.(),
        runTextTurn: async () =>
          await new Promise<string>((resolve) => {
            finishActive = () => resolve("active finished")
          }),
      }),
    })

    const active = tenant.runTextTurn("same", "active")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const queued = tenant.runTextTurn("same", "queued")

    await tenant.stop()

    await expect(active).resolves.toBe("active finished")
    const queuedResult = await queued
    expect(queuedResult).toBeInstanceOf(Error)
    if (queuedResult instanceof Error) {
      expect(queuedResult.message).toBe("tenant demo is stopping")
    }
  })

  it("stops Codex while an earlier schedule plugin drains during start rollback", async () => {
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
    const schedule = new LeucoScheduleChannelPlugin({
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
    const failing = fakePlugin("failing")
    failing.start = async () => {
      await turnStarted
      throw new Error("later plugin failed")
    }
    const tenant = buildTenant({ codex, plugins: [schedule, failing] })

    await expect(tenant.start()).rejects.toThrow("later plugin failed")

    expect(stop).toHaveBeenCalledTimes(1)
    expect(storeMutations).toEqual({ marks: 0, removes: 0 })
  })
})

describe("LeucoTenant.runTextTurn", () => {
  it("starts a new codex thread on first call and reuses it on subsequent calls", async () => {
    const startThread = vi.fn(async () => ({ thread: { id: "t-1" } }))
    const runTextTurn = vi.fn(async (id: string, text: string) => `${id}:${text}`)
    const tenant = buildTenant({ codex: fakeCodex({ startThread, runTextTurn }) })

    expect(await tenant.runTextTurn("k", "first")).toBe("t-1:first")
    expect(await tenant.runTextTurn("k", "second")).toBe("t-1:second")

    expect(startThread).toHaveBeenCalledTimes(1)
    expect(runTextTurn).toHaveBeenCalledTimes(2)
  })

  it("uses ONE codex thread regardless of how many threadKeys feed in", async () => {
    let starts = 0
    const tenant = buildTenant({
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `t-${++starts}` } }),
        runTextTurn: async (id) => id,
      }),
    })

    expect(await tenant.runTextTurn("a", "x")).toBe("t-1")
    expect(await tenant.runTextTurn("b", "x")).toBe("t-1")
    expect(await tenant.runTextTurn("a", "y")).toBe("t-1")
    expect(starts).toBe(1)
  })

  it("uses a separate codex thread per threadKey in thread scope", async () => {
    let starts = 0
    const tenant = buildTenant({
      conversationScope: "thread",
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `t-${++starts}` } }),
        runTextTurn: async (id) => id,
      }),
    })

    expect(await tenant.runTextTurn("a", "x")).toBe("t-1")
    expect(await tenant.runTextTurn("b", "x")).toBe("t-2")
    expect(await tenant.runTextTurn("a", "y")).toBe("t-1")
    expect(starts).toBe(2)
  })

  it("persists every thread-scope mapping without overwriting earlier keys", async () => {
    let starts = 0
    const setCodexThreadIds = vi.fn()
    const tenant = buildTenant({
      conversationScope: "thread",
      projectStateStore: {
        setCodexThreadId: vi.fn(),
        setCodexThreadIds,
      },
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `t-${++starts}` } }),
      }),
    })

    await tenant.runTextTurn("a", "first")
    await tenant.runTextTurn("b", "second")

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
    const tenant = buildTenant({
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

    const first = tenant.runTextTurn("a", "first")
    const second = tenant.runTextTurn("b", "second")
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(maxActive).toBe(2)
    releaseTurns()
    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
  })

  it("serializes turns within the same thread", async () => {
    const order: string[] = []
    const tenant = buildTenant({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          order.push(`enter:${text}`)
          await new Promise((r) => setTimeout(r, 10))
          order.push(`exit:${text}`)
          return text
        },
      }),
    })

    const p1 = tenant.runTextTurn("k", "1")
    const p2 = tenant.runTextTurn("k", "2")
    await Promise.all([p1, p2])

    expect(order).toEqual(["enter:1", "exit:1", "enter:2", "exit:2"])
  })

  it("returns underlying codex errors as Error instead of rejecting", async () => {
    const tenant = buildTenant({
      codex: fakeCodex({
        runTextTurn: async () => new Error("turn failed"),
      }),
    })

    const result = await tenant.runTextTurn("k", "x")
    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) expect(result.message).toBe("turn failed")
  })

  it("restarts codex after a command output budget error", async () => {
    let running = true
    const calls: string[] = []
    const tenant = buildTenant({
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

    const result = await tenant.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toBe("codex command output exceeded 200000 chars")
    }
    expect(calls).toEqual(["stop", "start"])
  })

  it("restarts codex when a turn stops producing notifications", async () => {
    let running = true
    const calls: string[] = []
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    const tenant = buildTenant({
      bus,
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

    const result = await tenant.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toContain("codex turn idle timeout after 0.005s")
    }
    expect(calls).toEqual(["stop", "start"])
    expect(events).toContainEqual(
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
    const tenant = buildTenant({
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

    const first = await tenant.runTextTurn("k", "first")
    expect(first).toBeInstanceOf(Error)
    if (first instanceof Error) {
      expect(first.message).toBe("codex turn hard deadline exceeded after 0.015s")
    }
    expect(calls).toEqual(["stop", "start"])

    await expect(tenant.runTextTurn("k", "second")).resolves.toBe("echo:second")
  })

  it("times out and recovers when thread/resume never replies", async () => {
    let running = true
    let resumeCalls = 0
    const calls: string[] = []
    const tenant = buildTenant({
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

    const first = await tenant.runTextTurn("k", "first")
    expect(first).toBeInstanceOf(Error)
    expect(calls).toEqual(["stop", "start"])
    await expect(tenant.runTextTurn("k", "second")).resolves.toBe("echo:second")
  })

  it("records recovery failure when the old codex child survives stop", async () => {
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    const start = vi.fn(async () => undefined)
    const tenant = buildTenant({
      bus,
      codex: fakeCodex({
        isRunning: () => true,
        stop: async () => undefined,
        start,
        runTextTurn: async () => new Error("codex app-server exited (code 1)"),
      }),
    })

    const result = await tenant.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    expect(start).not.toHaveBeenCalled()
    expect(events).toContainEqual(
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
    const tenant = buildTenant({
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

    const result = await tenant.runTextTurn("k", "x")

    expect(result).toBeInstanceOf(Error)
    if (result instanceof Error) {
      expect(result.message).toBe("codex turn hard deadline exceeded after 0.005s")
    }
    expect(calls).toEqual(["stop", "start"])
  })

  it("keeps an active turn alive while codex notifications continue", async () => {
    let notify: ((method: string) => void) | undefined
    let finish: ((reply: string) => void) | undefined
    const tenant = buildTenant({
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

    const resultPromise = tenant.runTextTurn("k", "x")
    await new Promise((resolve) => setTimeout(resolve, 20))
    notify?.("item/started")
    await new Promise((resolve) => setTimeout(resolve, 20))
    notify?.("item/commandExecution/outputDelta")
    await new Promise((resolve) => setTimeout(resolve, 20))
    finish?.("ok")

    await expect(resultPromise).resolves.toBe("ok")
  })

  it("bounds persisted turn input and reply diagnostics", async () => {
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    const large = "x".repeat(20_000)
    const tenant = buildTenant({
      bus,
      codex: fakeCodex({
        runTextTurn: async () => large,
      }),
    })

    await expect(tenant.runTextTurn("thread", large)).resolves.toBe(large)

    const start = events.find((event) => event.type === "turn.start")
    const complete = events.find((event) => event.type === "turn.complete")
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
    const tenant = buildTenant({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          calls.push(text)
          if (calls.length === 1) await firstTurnGate
          return text
        },
      }),
    })

    const p1 = tenant.runTextTurn("k", "1")
    // Let the first turn enter the gated codex.runTextTurn before queueing more.
    await new Promise((r) => setTimeout(r, 5))

    const p2 = tenant.runTextTurn("k", "2")
    const p3 = tenant.runTextTurn("k", "3")
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
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    let calls = 0
    const tenant = buildTenant({
      bus,
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

    const first = tenant.runTextTurn("k", "first")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const queued = tenant.runTextTurn("k", "queued")
    const rejected = await tenant.runTextTurn("k", "rejected")

    expect(rejected).toBeInstanceOf(Error)
    expect(events).toContainEqual(
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
    const tenant = buildTenant({
      turnQueueMaxBytes: 4,
      codex: fakeCodex({ runTextTurn }),
    })

    const result = await tenant.runTextTurn("k", "ああ")

    expect(result).toBeInstanceOf(Error)
    expect(runTextTurn).not.toHaveBeenCalled()
  })

  it("records queue depth, wait time, duration, and completion in logs and events", async () => {
    let releaseFirstTurn: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const logs: string[] = []
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    let attempts = 0
    const tenant = buildTenant({
      bus,
      onLog: (line) => logs.push(line),
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          attempts += 1
          if (attempts === 1) await firstTurnGate
          return text
        },
      }),
    })

    const first = tenant.runTextTurn("k", "first")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = tenant.runTextTurn("k", "second")
    releaseFirstTurn()
    await Promise.all([first, second])

    expect(logs.some((line) => line.includes("turn queued (pending=1)"))).toBe(true)
    expect(logs.some((line) => line.includes("turn complete duration="))).toBe(true)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.queued",
        project: "demo",
        queueDepth: 1,
      }),
    )
    expect(events).toContainEqual(
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
    const tenant = buildTenant({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          attempt += 1
          if (attempt === 1) return new Error("first fails")
          return text
        },
      }),
    })

    const first = await tenant.runTextTurn("k", "1")
    expect(first).toBeInstanceOf(Error)
    if (first instanceof Error) expect(first.message).toBe("first fails")
    await expect(tenant.runTextTurn("k", "2")).resolves.toBe("2")
  })
})

describe("LeucoTenant turn timeouts", () => {
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
      const tenant = buildTenant({
        codex,
        turnTimeoutMs: 1_000,
        turnIdleTimeoutMs: 20,
      })
      await tenant.start()

      const turn = tenant.runTextTurn("thread", "silent")
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
      const tenant = buildTenant({
        codex: fakeCodex({ stop, runTextTurn }),
        turnTimeoutMs: 1_000,
        turnIdleTimeoutMs: 20,
      })

      const turn = tenant.runTextTurn("thread", "active")
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
        const tenant = buildTenant({
          codex,
          initialCodexThreadId: threadAction === "resume" ? "saved-thread" : undefined,
          turnTimeoutMs: 20,
          turnIdleTimeoutMs: 1_000,
        })
        await tenant.start()

        const turn = tenant.runTextTurn("thread", "blocked setup")
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

describe("LeucoTenant Codex child recovery", () => {
  it("restarts after command output overflow without retrying or losing the thread", async () => {
    const reason = "codex command output exceeded 200000 chars from call_12345"
    const events: LeucoEvent[] = []
    const logs: string[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    let isRunning = true
    const calls: string[] = []
    let reportStopStarted: () => void = () => {}
    const stopStarted = new Promise<void>((resolve) => {
      reportStopStarted = resolve
    })
    const stopReleases: Array<() => void> = []
    const stop = vi.fn(async () => {
      calls.push("stop")
      reportStopStarted()
      await new Promise<void>((resolve) => stopReleases.push(resolve))
      isRunning = false
    })
    const start = vi.fn(async () => {
      calls.push("start")
      isRunning = true
    })
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
    const tenant = buildTenant({
      bus,
      onLog: (line) => logs.push(line),
      codex: fakeCodex({
        start,
        stop,
        isRunning: () => isRunning,
        startThread,
        resumeThread,
        runTextTurn,
      }),
    })

    let isFirstSettled = false
    const first = tenant.runTextTurn("thread", "first")
    void first.then(() => {
      isFirstSettled = true
    })
    await stopStarted

    expect(isFirstSettled).toBe(false)
    expect(calls).toEqual(["stop"])
    expect(runTextTurn).toHaveBeenCalledTimes(1)
    const releaseStop = stopReleases[0]
    if (!releaseStop) throw new Error("Codex stop gate was not installed")
    releaseStop()

    const failed = await first
    expect(failed).toEqual(new Error(reason))
    expect(calls).toEqual(["stop", "start"])
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "preserved-thread" }])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "codex.recovery",
        project: "demo",
        reason,
        status: "succeeded",
        error: null,
      }),
    )
    expect(logs.some((line) => line.includes("recovering codex child"))).toBe(true)
    expect(logs.some((line) => line.includes("codex recovery succeeded"))).toBe(true)

    await expect(tenant.runTextTurn("thread", "second")).resolves.toBe("ok")
    expect(runTextTurn).toHaveBeenCalledTimes(2)
    expect(startThread).toHaveBeenCalledTimes(1)
    expect(resumeThread).toHaveBeenCalledTimes(1)
    expect(resumeThread.mock.calls[0]?.[0].threadId).toBe("preserved-thread")
  })

  it("reports a failed overflow recovery while returning the original turn error", async () => {
    const reason = "codex command output exceeded 200000 chars from call_failed"
    const events: LeucoEvent[] = []
    const logs: string[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    let isRunning = true
    const tenant = buildTenant({
      bus,
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

    const reply = await tenant.runTextTurn("thread", "first")

    expect(reply).toEqual(new Error(reason))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "codex.recovery",
        reason,
        status: "failed",
        error: "spawn failed",
      }),
    )
    expect(logs.some((line) => line.includes("codex recovery failed"))).toBe(true)
  })

  it("discards a thread only when the same overflow call repeats after recovery", async () => {
    const reason = "turn failed: codex command output exceeded 200000 chars from call_stuck"
    let isRunning = true
    let turnCount = 0
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "fresh-thread" },
    }))
    const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(async (params) => ({
      thread: { id: params.threadId },
    }))
    const tenant = buildTenant({
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

    await expect(tenant.runTextTurn("thread", "first")).resolves.toEqual(new Error(reason))
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "saved-thread" }])

    await expect(tenant.runTextTurn("thread", "second")).resolves.toEqual(new Error(reason))
    expect(tenant.listThreads()).toEqual([])

    await expect(tenant.runTextTurn("thread", "third")).resolves.toBe("ok")
    expect(resumeThread).toHaveBeenCalledTimes(2)
    expect(startThread).toHaveBeenCalledTimes(1)
  })
})

describe("LeucoTenant queue admission", () => {
  it("admits 64 queued turns and rejects the next one with a structured event", async () => {
    let releaseFirstTurn: () => void = () => {}
    let reportFirstTurnEntered: () => void = () => {}
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const firstTurnEntered = new Promise<void>((resolve) => {
      reportFirstTurnEntered = resolve
    })
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    let callCount = 0
    const tenant = buildTenant({
      bus,
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

    const first = tenant.runTextTurn("thread", "first")
    await firstTurnEntered
    const queued = Array.from({ length: 64 }, (_unused, index) =>
      tenant.runTextTurn("thread", String(index)),
    )

    const rejected = await tenant.runTextTurn("thread", "overflow")
    expect(rejected).toBeInstanceOf(Error)
    if (rejected instanceof Error) expect(rejected.message).toContain("64 pending")

    const event = events.find((candidate) => candidate.type === "turn.rejected")
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
    const tenant = buildTenant({
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

    const first = tenant.runTextTurn("thread", "first")
    await firstTurnEntered
    const normal = Array.from({ length: 64 }, (_unused, index) =>
      tenant.runTextTurn("thread", `normal-${index}`),
    )
    const addressed = tenant.runTextTurn("mention", "addressed", { priority: "high" })

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
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    let callCount = 0
    const tenant = buildTenant({
      bus,
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

    const first = tenant.runTextTurn("thread", "first")
    await firstTurnEntered
    const admitted = tenant.runTextTurn("thread", "あ")
    const rejected = await tenant.runTextTurn("thread", "い")

    expect(rejected).toBeInstanceOf(Error)
    if (rejected instanceof Error) expect(rejected.message).toContain("5 UTF-8 bytes")
    const event = events.find((candidate) => candidate.type === "turn.rejected")
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

  it("rejects new work immediately after the tenant has stopped", async () => {
    const events: LeucoEvent[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => events.push(event))
    const runTextTurn = vi.fn<CodexClientPort["runTextTurn"]>(async () => "unexpected")
    const tenant = buildTenant({ bus, codex: fakeCodex({ runTextTurn }) })
    await tenant.stop()

    const reply = await tenant.runTextTurn("thread", "late")

    expect(reply).toBeInstanceOf(Error)
    expect(runTextTurn).not.toHaveBeenCalled()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.rejected",
        reason: "tenant_stopped",
        queueDepth: 0,
      }),
    )
  })
})

describe("LeucoTenant corrupt history recovery", () => {
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
    const tenant = buildTenant({
      initialCodexThreadId: "corrupt-thread",
      codex: fakeCodex({ resumeThread, startThread, runTextTurn }),
    })

    await expect(tenant.runTextTurn("thread", "hello")).resolves.toBe("fresh-thread")
    expect(resumeThread).toHaveBeenCalledTimes(1)
    expect(startThread).toHaveBeenCalledTimes(1)
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "fresh-thread" }])
  })

  it("keeps persisted history on authentication and network failures", async () => {
    const resumeThread = vi.fn<CodexClientPort["resumeThread"]>(
      async () => new Error("authentication failed: network connection reset"),
    )
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "unexpected" },
    }))
    const tenant = buildTenant({
      initialCodexThreadId: "saved-thread",
      codex: fakeCodex({ resumeThread, startThread }),
    })

    const first = await tenant.runTextTurn("thread", "first")
    const second = await tenant.runTextTurn("thread", "second")

    expect(first).toBeInstanceOf(Error)
    expect(second).toBeInstanceOf(Error)
    expect(resumeThread).toHaveBeenCalledTimes(2)
    expect(startThread).not.toHaveBeenCalled()
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "saved-thread" }])
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
    const tenant = buildTenant({ codex: fakeCodex({ startThread, runTextTurn }) })

    const failed = await tenant.runTextTurn("thread", "first")

    expect(failed).toEqual(
      new Error("codex session history was corrupted and has been reset; please resend"),
    )
    expect(tenant.listThreads()).toEqual([])
    await expect(tenant.runTextTurn("thread", "second")).resolves.toBe("ok")
    expect(startThread).toHaveBeenCalledTimes(2)
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "fresh-thread" }])
  })
})

describe("LeucoTenant introspection", () => {
  it("listPlugins returns plugin names", () => {
    const tenant = buildTenant({ plugins: [fakePlugin("one"), fakePlugin("two")] })
    expect(tenant.listPlugins()).toEqual(["one", "two"])
  })

  it("key returns the project name", () => {
    const tenant = new LeucoTenant({
      projectId: "00000000-0000-4000-8000-000000000000",
      projectName: "p",
      projectPath: "/tmp/p",
      codex: fakeCodex(),
      plugins: [],
      onLog: () => {},
    })
    expect(tenant.key).toBe("p")
  })

  it("listThreads exposes the agent's single codex thread once a turn has run", async () => {
    const tenant = buildTenant({
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: "tx" } }),
        runTextTurn: async () => "ok",
      }),
    })

    await tenant.runTextTurn("k1", "hi")
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "tx" }])

    expect(tenant.clearThread(tenant.key)).toBe(true)
    expect(tenant.listThreads()).toEqual([])
    expect(tenant.clearThread(tenant.key)).toBe(false)
  })

  it("lists and clears independent thread-scope mappings", async () => {
    let starts = 0
    const tenant = buildTenant({
      conversationScope: "thread",
      codex: fakeCodex({
        startThread: async () => ({ thread: { id: `tx-${++starts}` } }),
        runTextTurn: async () => "ok",
      }),
    })

    await tenant.runTextTurn("slack:C1:T1", "one")
    await tenant.runTextTurn("slack:C1:T2", "two")
    expect(tenant.listThreads()).toEqual([
      { threadKey: "slack:C1:T1", threadId: "tx-1" },
      { threadKey: "slack:C1:T2", threadId: "tx-2" },
    ])

    expect(tenant.clearThread("tx-1")).toBe(true)
    expect(tenant.listThreads()).toEqual([{ threadKey: "slack:C1:T2", threadId: "tx-2" }])
  })

  it("isCodexRunning delegates to the codex port", () => {
    const tenant = buildTenant({ codex: fakeCodex({ isRunning: () => false }) })
    expect(tenant.isCodexRunning()).toBe(false)
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
    const tenant = buildTenant({ codex: fakeCodex({ startThread, runTextTurn }) })

    const failed = await tenant.runTextTurn("k", "first")

    expect(failed).toEqual(
      new Error("codex session history was corrupted and has been reset; please resend"),
    )
    expect(tenant.listThreads()).toEqual([])

    await expect(tenant.runTextTurn("k", "second")).resolves.toBe("ok")
    expect(startThread).toHaveBeenCalledTimes(2)
    expect(tenant.listThreads()).toEqual([{ threadKey: tenant.key, threadId: "fresh-thread" }])
  })
})

describe("LeucoTenant developer instructions", () => {
  it("prepends the dynamic preamble by default and folds in channel identities", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const tenant = buildTenant({
      codex: fakeCodex({ startThread }),
      plugins: [fakePlugin("general", { botUserId: "U777" })],
      agentSpec: { developerInstructions: "you are mochi" },
    })

    await tenant.runTextTurn("k", "hi")

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
    const tenant = buildTenant({
      codex: fakeCodex({ startThread }),
      plugins: [fakePlugin("general", { botUserId: "U777" })],
      agentSpec: { developerInstructions: "raw instructions only" },
      useCommonInstructions: false,
    })

    await tenant.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toBe("raw instructions only")
  })

  it("omits developer instructions entirely when neither preamble nor per-agent text is configured", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const tenant = buildTenant({
      codex: fakeCodex({ startThread }),
      useCommonInstructions: false,
    })

    await tenant.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toBeUndefined()
  })

  it("splices configured presets between the preamble and the per-agent tail", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const tenant = buildTenant({
      codex: fakeCodex({ startThread }),
      agentSpec: { developerInstructions: "you are mochi" },
      presets: ["# Friendly\nbe warm"],
    })

    await tenant.runTextTurn("k", "hi")

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
    const tenant = buildTenant({
      codex: fakeCodex({ startThread }),
      useCommonInstructions: false,
      presets: ["# Friendly\nbe warm"],
      agentSpec: { developerInstructions: "tail" },
    })

    await tenant.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toBe("# Friendly\nbe warm\n\n---\n\ntail")
  })
})

describe("LeucoTenant.stop with queued turns", () => {
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

    const tenant = buildTenant({ codex })
    await tenant.start()

    const first = tenant.runTextTurn("thread", "one")
    const second = tenant.runTextTurn("thread", "two")

    const stopPromise = tenant.stop()
    const secondReply = await second
    expect(secondReply).toBeInstanceOf(Error)

    await new Promise((resolve) => setTimeout(resolve, 0))
    releaseTurn("done")

    await stopPromise
    const firstReply = await first
    expect(firstReply).toBe("done")

    // exactly the one spawn from tenant.start(); the drained queue must not
    // have respawned the codex child after stop() killed it
    expect(starts).toHaveLength(1)

    const third = await tenant.runTextTurn("thread", "three")
    expect(third).toBeInstanceOf(Error)
  })

  it("stops Codex while a schedule plugin drains its in-flight turn", async () => {
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
    const schedule = new LeucoScheduleChannelPlugin({
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
    const tenant = buildTenant({ codex, plugins: [schedule] })
    await tenant.start()
    await turnStarted

    await tenant.stop()

    expect(stop).toHaveBeenCalledTimes(1)
    expect(storeMutations).toEqual({ marks: 0, removes: 0 })
    await Promise.resolve()
    expect(storeMutations).toEqual({ marks: 0, removes: 0 })
  })
})
