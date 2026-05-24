import { describe, expect, it } from "vitest"
import type { Agent, Project } from "@/config/config-schema"
import { LeucoEngine } from "@/engine/engine"
import { LeucoTenant } from "@/engine/tenant"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import type { LeucoProjectStore } from "@/projects/project-store"

const fakeCodex = (overrides: Partial<CodexClientPort> = {}): CodexClientPort => ({
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: () => true,
  startThread: async () => ({ thread: { id: "tx" } }),
  resumeThread: async (params) => ({ thread: { id: params.threadId } }),
  runTextTurn: async (_id, text) => text,
  ...overrides,
})

const buildTenant = (
  projectName: string,
  agentName: string,
  codex: CodexClientPort = fakeCodex(),
) =>
  new LeucoTenant({
    projectId: `00000000-0000-4000-8000-${projectName.padStart(12, "0").slice(0, 12)}`,
    projectName,
    projectPath: `/tmp/${projectName}`,
    agentName,
    codex,
    plugins: [],
    onLog: () => {},
  })

const fakeStore = (projects: Project[] = []): LeucoProjectStore => {
  return {
    list: () => projects,
    load: (id: string) => projects.find((p) => p.id === id) ?? new Error("not found"),
    resolveByName: (name: string) =>
      projects.find((p) => p.name === name) ?? new Error("not found"),
    resolveByCwd: () => new Error("not used"),
    save: () => "" as string | Error,
    remove: () => undefined,
    getPaths: () => ({}) as never,
  } as unknown as LeucoProjectStore
}

const noBuild = (): LeucoTenant | Error => new Error("buildTenant not configured")

describe("LeucoEngine.start / stop", () => {
  it("starts each tenant in order", async () => {
    const calls: string[] = []
    const a = buildTenant(
      "demo",
      "a",
      fakeCodex({
        start: async () => {
          calls.push("a.start")
        },
      }),
    )
    const b = buildTenant(
      "demo",
      "b",
      fakeCodex({
        start: async () => {
          calls.push("b.start")
        },
      }),
    )

    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    await engine.start()

    expect(calls).toEqual(["a.start", "b.start"])
  })

  it("stops each tenant on engine.stop()", async () => {
    const stops: string[] = []
    const a = buildTenant(
      "demo",
      "a",
      fakeCodex({
        stop: async () => {
          stops.push("a")
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    await engine.start()
    await engine.stop()

    expect(stops).toEqual(["a"])
  })
})

describe("LeucoEngine.reconcile", () => {
  const project = (name: string, agents: Agent[]): Project => ({
    id: `00000000-0000-4000-8000-${name.padStart(12, "0").slice(0, 12)}`,
    name,
    path: `/tmp/${name}`,
    agents,
  })
  const agent = (name: string, enabled = true): Agent => ({
    name,
    enabled,
    useCommonInstructions: true,
    prompts: ["friendly"],
    channels: [],
    mcpServers: {},
  })

  it("stops tenants whose agent has been disabled", async () => {
    const stops: string[] = []
    const a = buildTenant(
      "demo",
      "a",
      fakeCodex({
        stop: async () => {
          stops.push("a")
        },
      }),
    )
    const projects = [project("demo", [agent("a", false)])]
    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(projects),
      buildTenant: noBuild,
      onLog: () => {},
    })

    await engine.reconcile()
    expect(stops).toEqual(["a"])
    expect(engine.listProjects()[0]?.agents[0]?.tenantRunning).toBe(false)
  })

  it("starts tenants whose agent is newly enabled", async () => {
    const starts: string[] = []
    const built = buildTenant(
      "demo",
      "b",
      fakeCodex({
        start: async () => {
          starts.push("b")
        },
      }),
    )
    const projects = [project("demo", [agent("b", true)])]
    const engine = new LeucoEngine({
      tenants: [],
      projectStore: fakeStore(projects),
      buildTenant: () => built,
      onLog: () => {},
    })

    await engine.reconcile()
    expect(starts).toEqual(["b"])
    expect(engine.listProjects()[0]?.agents[0]?.tenantRunning).toBe(true)
  })

  it("serializes concurrent reconcile() calls so a tenant is not double-started", async () => {
    const starts: string[] = []
    let releaseFirstStart: () => void = () => {}
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })

    let buildCalls = 0
    const built = buildTenant(
      "demo",
      "b",
      fakeCodex({
        start: async () => {
          starts.push("b")
          if (starts.length === 1) await firstStartGate
        },
      }),
    )

    const projects = [project("demo", [agent("b", true)])]
    const engine = new LeucoEngine({
      tenants: [],
      projectStore: fakeStore(projects),
      buildTenant: () => {
        buildCalls++
        return built
      },
      onLog: () => {},
    })

    const first = engine.reconcile()
    const second = engine.reconcile()

    // Give the second call a chance to enter; if it's not queued behind
    // the first, it would already be calling start() against the same tenant.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(starts).toEqual(["b"])

    releaseFirstStart()
    await first
    await second

    expect(starts).toEqual(["b"])
    expect(buildCalls).toBe(1)
  })

  it("keeps tenants that are still enabled and present", async () => {
    const stops: string[] = []
    const a = buildTenant(
      "demo",
      "a",
      fakeCodex({
        stop: async () => {
          stops.push("a")
        },
      }),
    )
    const projects = [project("demo", [agent("a", true)])]
    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(projects),
      buildTenant: noBuild,
      onLog: () => {},
    })

    await engine.reconcile()
    expect(stops).toEqual([])
  })
})

describe("LeucoEngine introspection", () => {
  it("listThreads exposes the agent's single codex thread once a turn has run", async () => {
    const a = buildTenant(
      "demo",
      "a",
      fakeCodex({ startThread: async () => ({ thread: { id: "tA" } }) }),
    )
    await a.runTextTurn("k1", "x")

    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    expect(engine.listThreads()).toEqual([
      { tenantKey: "demo:a", threadKey: "demo:a", threadId: "tA" },
    ])
  })

  it("listProjects returns enabled state plus running flag for each agent", () => {
    const projects = [
      {
        id: "00000000-0000-4000-8000-000000000000",
        name: "demo",
        path: "/tmp/demo",
        agents: [
          {
            name: "a",
            enabled: true,
            useCommonInstructions: true,
            prompts: ["friendly" as const],
            channels: [],
            mcpServers: {},
          },
          {
            name: "b",
            enabled: false,
            useCommonInstructions: true,
            prompts: ["friendly" as const],
            channels: [],
            mcpServers: {},
          },
        ],
      },
    ]
    const a = buildTenant("demo", "a")
    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(projects),
      buildTenant: noBuild,
      onLog: () => {},
    })

    const summary = engine.listProjects()
    expect(summary[0]?.agents).toEqual([
      { name: "a", enabled: true, tenantRunning: true },
      { name: "b", enabled: false, tenantRunning: false },
    ])
  })

  it("isCodexRunning is true when any tenant is running", () => {
    const a = buildTenant("demo", "a", fakeCodex({ isRunning: () => false }))
    const b = buildTenant("demo", "b", fakeCodex({ isRunning: () => true }))
    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    expect(engine.isCodexRunning()).toBe(true)
  })
})
