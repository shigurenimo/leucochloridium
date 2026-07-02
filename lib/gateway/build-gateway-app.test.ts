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
    listProjects: () => [],
    clearThread: () => true,
  } as unknown as LeucoEngine
  return Object.assign(base, overrides)
}

describe("buildGatewayApp / GET /health", () => {
  it("returns liveness + plugin list", async () => {
    const app = buildGatewayApp({ selfPid: 999, engine: fakeEngine(), mcpTokenForProject: null })
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
    const app = buildGatewayApp({ selfPid: 999, engine: fakeEngine(), mcpTokenForProject: null })
    const res = await app.request("/status")
    expect(await res.json()).toEqual({
      ok: true,
      pid: 999,
      cwd: "/tmp",
      plugins: ["demo:default:slack"],
      codexRunning: true,
      threads: [{ tenantKey: "demo:default", threadKey: "k1", threadId: "t1" }],
      projects: [],
    })
  })
})

describe("buildGatewayApp / GET /threads", () => {
  it("returns the active thread map", async () => {
    const app = buildGatewayApp({ selfPid: 1, engine: fakeEngine(), mcpTokenForProject: null })
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
    const app = buildGatewayApp({ selfPid: 1, engine, mcpTokenForProject: null })
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
    const app = buildGatewayApp({ selfPid: 1, engine, mcpTokenForProject: null })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: JSON.stringify({ threadKey: "missing" }),
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("error: thread not found: missing")
  })

  it("returns 400 when threadKey is missing from the body", async () => {
    const app = buildGatewayApp({ selfPid: 1, engine: fakeEngine(), mcpTokenForProject: null })
    const res = await app.request("/threads/clear", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("error: threadKey required in body")
  })
})

describe("buildGatewayApp / POST /mcp/:project auth", () => {
  const PROJECT_A = "00000000-0000-4000-8000-00000000000a"
  const PROJECT_B = "00000000-0000-4000-8000-00000000000b"

  const tokens = new Map([
    [PROJECT_A, "token-a"],
    [PROJECT_B, "token-b"],
  ])

  const appWithTokens = () =>
    buildGatewayApp({
      selfPid: 1,
      engine: fakeEngine(),
      mcpTokenForProject: (projectId) => tokens.get(projectId) ?? null,
    })

  const post = (app: ReturnType<typeof appWithTokens>, projectId: string, token: string) =>
    app.request(`/mcp/${projectId}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    })

  it("returns 503 when mcp is disabled", async () => {
    const app = buildGatewayApp({ selfPid: 1, engine: fakeEngine(), mcpTokenForProject: null })
    const res = await post(app, PROJECT_A, "token-a")
    expect(res.status).toBe(503)
  })

  it("rejects another tenant's token", async () => {
    const res = await post(appWithTokens(), PROJECT_A, "token-b")
    expect(res.status).toBe(401)
  })

  it("rejects a project without a token", async () => {
    const res = await post(appWithTokens(), "00000000-0000-4000-8000-00000000000c", "token-a")
    expect(res.status).toBe(401)
  })

  it("accepts the project's own token", async () => {
    const res = await post(appWithTokens(), PROJECT_A, "token-a")
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(503)
  })
})
