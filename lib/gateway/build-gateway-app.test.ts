import { describe, expect, it } from "vitest"
import type { DaemonControl, DaemonThreadSummary } from "@/control/daemon-control"
import { buildGatewayApp } from "@/gateway/build-gateway-app"

const fakeControl = (overrides: Partial<DaemonControl> = {}): DaemonControl => {
  const base = {
    getCwd: () => "/tmp",
    isCodexRunning: () => true,
    listConnectors: () => ["demo:default:slack"],
    listThreads: (): DaemonThreadSummary[] => [
      { project: "demo:default", threadKey: "k1", threadId: "t1" },
    ],
    listProjects: () => [],
    clearThread: () => true,
    reload: async () => undefined,
    restartProject: async () => undefined,
    restartConnector: async () => undefined,
    resetProjectSession: async () => undefined,
    pauseProject: async () => undefined,
    resumeProject: async () => undefined,
  }
  return Object.assign(base, overrides)
}

describe("buildGatewayApp / GET /health", () => {
  it("returns liveness + connector list", async () => {
    const app = buildGatewayApp({ selfPid: 999, control: fakeControl() })
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      pid: 999,
      connectors: ["demo:default:slack"],
      codexRunning: true,
    })
  })
})

describe("buildGatewayApp / GET /status", () => {
  it("returns the full snapshot", async () => {
    const app = buildGatewayApp({ selfPid: 999, control: fakeControl() })
    const res = await app.request("/status")
    expect(await res.json()).toEqual({
      ok: true,
      pid: 999,
      cwd: "/tmp",
      connectors: ["demo:default:slack"],
      codexRunning: true,
      threads: [{ project: "demo:default", threadKey: "k1", threadId: "t1" }],
      projects: [],
    })
  })
})

describe("buildGatewayApp / GET /threads", () => {
  it("returns the active thread map", async () => {
    const app = buildGatewayApp({ selfPid: 1, control: fakeControl() })
    const res = await app.request("/threads")
    expect(await res.json()).toEqual({
      threads: [{ project: "demo:default", threadKey: "k1", threadId: "t1" }],
    })
  })
})

describe("buildGatewayApp / built-in MCP removal", () => {
  it("does not expose the former project MCP endpoint", async () => {
    const app = buildGatewayApp({ selfPid: 1, control: fakeControl() })
    const res = await app.request("/mcp/00000000-0000-4000-8000-000000000000", {
      method: "POST",
    })

    expect(res.status).toBe(404)
  })
})

describe("buildGatewayApp / POST /threads/clear", () => {
  it("clears a thread by key and reports ok=true", async () => {
    const cleared: string[] = []
    const control = fakeControl({
      clearThread: (key: string) => {
        cleared.push(key)
        return true
      },
    })
    const app = buildGatewayApp({ selfPid: 1, control })
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
    const control = fakeControl({ clearThread: () => false })
    const app = buildGatewayApp({ selfPid: 1, control })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: JSON.stringify({ threadKey: "missing" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("error: thread not found: missing")
  })

  it("returns 400 when threadKey is missing from the body", async () => {
    const app = buildGatewayApp({ selfPid: 1, control: fakeControl() })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("error: threadKey required in body")
  })
})
