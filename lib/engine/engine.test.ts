import { describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
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

const buildTenant = (projectName: string, codex: CodexClientPort = fakeCodex()) =>
  new LeucoTenant({
    projectId: `00000000-0000-4000-8000-${projectName.padStart(12, "0").slice(0, 12)}`,
    projectName,
    projectPath: `/tmp/${projectName}`,
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

const noBuild = (): LeucoTenant => {
  throw new Error("buildTenant not configured")
}

const makeProject = (name: string, enabled = true): Project => ({
  version: 2,
  id: `00000000-0000-4000-8000-${name.padStart(12, "0").slice(0, 12)}`,
  name,
  path: `/tmp/${name}`,
  enabled,
  useCommonInstructions: true,
  prompts: ["friendly"],
  channels: [],
  mcpServers: {},
})

describe("LeucoEngine.start / stop", () => {
  it("starts each tenant in order", async () => {
    const calls: string[] = []
    const a = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          calls.push("a.start")
        },
      }),
    )
    const b = buildTenant(
      "bravo",
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
      "alpha",
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

  it("rolls back already-started tenants when a later start fails", async () => {
    const events: string[] = []
    const a = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          events.push("a.start")
        },
        stop: async () => {
          events.push("a.stop")
        },
      }),
    )
    const b = buildTenant(
      "bravo",
      fakeCodex({
        start: async () => {
          events.push("b.start")
          throw new Error("b failed")
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })

    await expect(engine.start()).rejects.toThrow("b failed")
    expect(events).toEqual(["a.start", "b.start", "a.stop"])
  })

  it("keeps draining tenants even when one fails to stop", async () => {
    const stops: string[] = []
    const a = buildTenant(
      "alpha",
      fakeCodex({
        stop: async () => {
          stops.push("a")
          throw new Error("a stop boom")
        },
      }),
    )
    const b = buildTenant(
      "bravo",
      fakeCodex({
        stop: async () => {
          stops.push("b")
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
    await engine.stop()

    expect(stops).toEqual(["a", "b"])
  })
})

describe("LeucoEngine.reconcile", () => {
  it("stops tenants whose project has been disabled", async () => {
    const stops: string[] = []
    const a = buildTenant(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("demo")
        },
      }),
    )
    const projects = [makeProject("demo", false)]
    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(projects),
      buildTenant: noBuild,
      onLog: () => {},
    })

    await engine.reconcile()
    expect(stops).toEqual(["demo"])
    expect(engine.listProjects()[0]?.tenantRunning).toBe(false)
  })

  it("starts tenants whose project is newly enabled", async () => {
    const starts: string[] = []
    const built = buildTenant(
      "demo",
      fakeCodex({
        start: async () => {
          starts.push("demo")
        },
      }),
    )
    const projects = [makeProject("demo", true)]
    const engine = new LeucoEngine({
      tenants: [],
      projectStore: fakeStore(projects),
      buildTenant: () => built,
      onLog: () => {},
    })

    await engine.reconcile()
    expect(starts).toEqual(["demo"])
    expect(engine.listProjects()[0]?.tenantRunning).toBe(true)
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
      fakeCodex({
        start: async () => {
          starts.push("demo")
          if (starts.length === 1) await firstStartGate
        },
      }),
    )

    const projects = [makeProject("demo", true)]
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

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(starts).toEqual(["demo"])

    releaseFirstStart()
    await first
    await second

    expect(starts).toEqual(["demo"])
    expect(buildCalls).toBe(1)
  })

  it("keeps tenants that are still enabled and present", async () => {
    const stops: string[] = []
    const a = buildTenant(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("demo")
        },
      }),
    )
    const projects = [makeProject("demo", true)]
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
  it("listThreads exposes the project's single codex thread once a turn has run", async () => {
    const a = buildTenant(
      "demo",
      fakeCodex({ startThread: async () => ({ thread: { id: "tA" } }) }),
    )
    await a.runTextTurn("k1", "x")

    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    expect(engine.listThreads()).toEqual([{ tenantKey: "demo", threadKey: "demo", threadId: "tA" }])
  })

  it("listProjects returns enabled state plus running flag for each project", () => {
    const projects = [makeProject("alpha", true), makeProject("bravo", false)]
    const a = buildTenant("alpha")
    const engine = new LeucoEngine({
      tenants: [a],
      projectStore: fakeStore(projects),
      buildTenant: noBuild,
      onLog: () => {},
    })

    const summary = engine.listProjects()
    expect(summary).toEqual([
      { name: "alpha", path: "/tmp/alpha", enabled: true, tenantRunning: true },
      { name: "bravo", path: "/tmp/bravo", enabled: false, tenantRunning: false },
    ])
  })

  it("isCodexRunning is true when any tenant is running", () => {
    const a = buildTenant("alpha", fakeCodex({ isRunning: () => false }))
    const b = buildTenant("bravo", fakeCodex({ isRunning: () => true }))
    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    expect(engine.isCodexRunning()).toBe(true)
  })
})
