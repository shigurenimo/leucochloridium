import { describe, expect, it, vi } from "vitest"
import type {
  ChannelIdentity,
  ChannelPlugin,
  ChannelPluginContext,
} from "@/channels/channel-plugin"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoTenant } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoEvent } from "@/events/leuco-event-types"

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
  useCommonInstructions?: boolean
  presets?: string[]
  onLog?: (line: string) => void
  bus?: LeucoEventBus
  turnTimeoutMs?: number
  turnIdleTimeoutMs?: number
  turnQueueMaxItems?: number
  turnQueueMaxBytes?: number
  initialCodexThreadId?: string
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
    useCommonInstructions: overrides.useCommonInstructions,
    presets: overrides.presets,
    onLog: overrides.onLog ?? (() => {}),
    bus: overrides.bus,
    turnTimeoutMs: overrides.turnTimeoutMs,
    turnIdleTimeoutMs: overrides.turnIdleTimeoutMs,
    turnQueueMaxItems: overrides.turnQueueMaxItems,
    turnQueueMaxBytes: overrides.turnQueueMaxBytes,
    initialCodexThreadId: overrides.initialCodexThreadId,
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
      expect(result.message).toContain("codex turn idle timed out after 0.005s")
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
      expect(first.message).toBe("codex turn timed out after 0.015s")
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
      expect(result.message).toBe("codex turn timed out after 0.005s")
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
        runTextTurn: async (_threadId, _text, _cwd, onActivity) =>
          await new Promise<string>((resolve) => {
            notify = onActivity
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

  it("batches turns that arrive while another turn is in flight", async () => {
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
    // Let the first turn enter the gated codex.runTextTurn before queueing
    // more — otherwise everything ends up in a single batch.
    await new Promise((r) => setTimeout(r, 5))

    const p2 = tenant.runTextTurn("k", "2")
    const p3 = tenant.runTextTurn("k", "3")
    releaseFirstTurn()

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(calls).toEqual(["1", "2\n\n3"])
    expect(r1).toBe("1")
    expect(r2).toBe("2\n\n3")
    expect(r3).toBe("2\n\n3")
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

  it("isCodexRunning delegates to the codex port", () => {
    const tenant = buildTenant({ codex: fakeCodex({ isRunning: () => false }) })
    expect(tenant.isCodexRunning()).toBe(false)
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
