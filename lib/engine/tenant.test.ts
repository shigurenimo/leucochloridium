import { describe, expect, it, vi } from "vitest"
import type { ChannelPlugin, ChannelPluginContext } from "@/engine/channel-plugin"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
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

const fakePlugin = (name: string): ChannelPlugin & { ctx: ChannelPluginContext | null } => {
  const plugin: ChannelPlugin & { ctx: ChannelPluginContext | null } = {
    name,
    ctx: null,
    async start(ctx) {
      plugin.ctx = ctx
    },
    async stop() {
      plugin.ctx = null
    },
  }
  return plugin
}

const buildTenant = (overrides: { codex?: CodexClientPort; plugins?: ChannelPlugin[] } = {}) =>
  new LeucoTenant({
    projectName: "demo",
    projectPath: "/tmp/demo",
    agentName: "default",
    codex: overrides.codex ?? fakeCodex(),
    plugins: overrides.plugins ?? [],
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

  it("propagates underlying codex errors to the caller", async () => {
    const tenant = buildTenant({
      codex: fakeCodex({
        runTextTurn: async () => Promise.reject(new Error("turn failed")),
      }),
    })

    await expect(tenant.runTextTurn("k", "x")).rejects.toThrow("turn failed")
  })

  it("recovers a failed turn so the next turn in the same thread still runs", async () => {
    let attempt = 0
    const tenant = buildTenant({
      codex: fakeCodex({
        runTextTurn: async (_id, text) => {
          attempt += 1
          if (attempt === 1) return Promise.reject(new Error("first fails"))
          return text
        },
      }),
    })

    await expect(tenant.runTextTurn("k", "1")).rejects.toThrow("first fails")
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
