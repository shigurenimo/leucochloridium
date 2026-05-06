import { describe, expect, it } from "vitest"
import type { LeucoEngine, ThreadEntry } from "@/engine/engine"
import { buildGatewayApp } from "@/gateway/build-gateway-app"

const fakeEngine = (overrides: Partial<LeucoEngine> = {}): LeucoEngine => {
  const base = {
    getCwd: () => "/tmp",
    isCodexRunning: () => true,
    listPlugins: () => ["demo:default:slack"],
    listThreads: (): ThreadEntry[] => [
      { tenantKey: "demo:default", threadKey: "k1", threadId: "t1" },
    ],
    clearThread: () => true,
  } as unknown as LeucoEngine
  return Object.assign(base, overrides)
}

describe("buildGatewayApp / GET /health", () => {
  it("returns liveness + plugin list", async () => {
    const app = buildGatewayApp({ selfPid: 999, engine: fakeEngine() })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      pid: 999,
      plugins: ["demo:default:slack"],
      codexRunning: true,
    })
  })
})

describe("buildGatewayApp / GET /status", () => {
  it("returns the full snapshot", async () => {
    const app = buildGatewayApp({ selfPid: 999, engine: fakeEngine() })
    const res = await app.request("/status")
    expect(await res.json()).toEqual({
      ok: true,
      pid: 999,
      cwd: "/tmp",
      plugins: ["demo:default:slack"],
      codexRunning: true,
      threads: [{ tenantKey: "demo:default", threadKey: "k1", threadId: "t1" }],
    })
  })
})

describe("buildGatewayApp / GET /threads", () => {
  it("returns the active thread map", async () => {
    const app = buildGatewayApp({ selfPid: 1, engine: fakeEngine() })
    const res = await app.request("/threads")
    expect(await res.json()).toEqual({
      threads: [{ tenantKey: "demo:default", threadKey: "k1", threadId: "t1" }],
    })
  })
})

describe("buildGatewayApp / POST /threads/clear", () => {
  it("clears a thread by key and reports ok=true", async () => {
    const cleared: string[] = []
    const engine = fakeEngine({
      clearThread: ((key: string) => {
        cleared.push(key)
        return true
      }) as LeucoEngine["clearThread"],
    })
    const app = buildGatewayApp({ selfPid: 1, engine })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: JSON.stringify({ threadKey: "k1" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, threadKey: "k1" })
    expect(cleared).toEqual(["k1"])
  })

  it("returns 404 when the thread is unknown", async () => {
    const engine = fakeEngine({ clearThread: (() => false) as LeucoEngine["clearThread"] })
    const app = buildGatewayApp({ selfPid: 1, engine })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: JSON.stringify({ threadKey: "missing" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, threadKey: "missing" })
  })

  it("returns 400 when threadKey is missing from the body", async () => {
    const app = buildGatewayApp({ selfPid: 1, engine: fakeEngine() })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(400)
  })
})
