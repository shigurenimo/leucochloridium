import { describe, expect, it, vi } from "vitest"
import type { ChannelIdentity, ChannelPlugin, ChannelPluginContext } from "@/engine/channel-plugin"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import type { SubagentEntry } from "@/engine/system-prompt-builder"
import { LeucoTenant } from "@/engine/tenant"

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
  listSubagents?: () => SubagentEntry[]
  presets?: string[]
}

const buildTenant = (overrides: BuildOverrides = {}) =>
  new LeucoTenant({
    projectName: "demo",
    projectPath: "/tmp/demo",
    agentName: "default",
    codex: overrides.codex ?? fakeCodex(),
    plugins: overrides.plugins ?? [],
    agentSpec: overrides.agentSpec,
    useCommonInstructions: overrides.useCommonInstructions,
    listSubagents: overrides.listSubagents,
    presets: overrides.presets,
    onLog: () => {},
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

  it("key combines projectName and agentName", () => {
    const tenant = new LeucoTenant({
      projectName: "p",
      projectPath: "/tmp/p",
      agentName: "a",
      codex: fakeCodex(),
      plugins: [],
      onLog: () => {},
    })
    expect(tenant.key).toBe("p:a")
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
  it("prepends the dynamic preamble by default and folds in identities + subagents", async () => {
    const startThread = vi.fn<CodexClientPort["startThread"]>(async () => ({
      thread: { id: "t1" },
    }))
    const tenant = buildTenant({
      codex: fakeCodex({ startThread }),
      plugins: [fakePlugin("general", { botUserId: "U777" })],
      agentSpec: { developerInstructions: "you are mochi" },
      listSubagents: () => [{ name: "reviewer", path: "/tmp/demo/.codex/agents/reviewer.toml" }],
    })

    await tenant.runTextTurn("k", "hi")

    const arg = startThread.mock.calls[0]?.[0]
    if (arg === undefined) throw new Error("startThread was never called")
    expect(arg.developerInstructions).toContain("# leuco built-in instructions")
    expect(arg.developerInstructions).toContain("`U777`")
    expect(arg.developerInstructions).toContain("/tmp/demo/.codex/agents/reviewer.toml")
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
