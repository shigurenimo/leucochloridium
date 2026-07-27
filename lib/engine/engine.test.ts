import { describe, expect, it, vi } from "vitest"
import type { Project } from "@/config/config-schema"
import { LeucoEngine } from "@/engine/engine"
import { PromptPreset } from "@/prompts/presets"
import { LeucoTenant } from "@/engine/tenant"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoEventBus } from "@/events/leuco-event-bus"
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

const idFromName = (name: string): string =>
  `00000000-0000-4000-8000-${name.padStart(12, "0").slice(0, 12)}`

const buildTenant = (
  projectName: string,
  codex: CodexClientPort = fakeCodex(),
  projectId?: string,
) =>
  new LeucoTenant({
    projectId: projectId ?? idFromName(projectName),
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
  conversationScope: "project",
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [PromptPreset.CORE, PromptPreset.STYLE_WORK, PromptPreset.STYLE_SLACK],
  channels: [],
  mcpServers: {},
  state: { codexThreadId: null, codexThreadIds: {}, scheduleLastFiredAt: {} },
})

describe("LeucoEngine.start / stop", () => {
  it("starts the gateway before tenants and stops it after tenants", async () => {
    const calls: string[] = []
    const a = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          calls.push("a.start")
        },
        stop: async () => {
          calls.push("a.stop")
        },
      }),
    )
    const b = buildTenant(
      "bravo",
      fakeCodex({
        start: async () => {
          calls.push("b.start")
        },
        stop: async () => {
          calls.push("b.stop")
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      port: 7331,
      onLog: () => {},
      buildGateway: () => ({
        start: () => {
          calls.push("gateway.start")
        },
        stop: async () => {
          calls.push("gateway.stop")
        },
      }),
    })

    await engine.start()
    await engine.stop()

    expect(calls).toEqual([
      "gateway.start",
      "a.start",
      "b.start",
      "a.stop",
      "b.stop",
      "gateway.stop",
    ])
  })

  it("keeps the gateway and healthy tenants running when another tenant fails to start", async () => {
    const calls: string[] = []
    const failures: string[] = []
    const bus = new LeucoEventBus()
    bus.subscribe((event) => {
      if (event.type === "engine.reconcile.failed") failures.push(event.reason)
    })
    const a = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          calls.push("a.start")
        },
        stop: async () => {
          calls.push("a.stop")
        },
      }),
    )
    const b = buildTenant(
      "bravo",
      fakeCodex({
        start: async () => {
          calls.push("b.start")
          throw new Error("b failed")
        },
        stop: async () => {
          calls.push("b.stop")
        },
      }),
    )
    const projects = [makeProject("alpha"), makeProject("bravo")]
    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore(projects),
      buildTenant: noBuild,
      port: 7331,
      onLog: () => {},
      bus,
      buildGateway: () => ({
        start: () => {
          calls.push("gateway.start")
        },
        stop: async () => {
          calls.push("gateway.stop")
        },
      }),
    })

    await engine.start()

    expect(calls).toEqual(["gateway.start", "a.start", "b.start", "b.stop"])
    expect(engine.listProjects().map((project) => project.tenantRunning)).toEqual([true, false])
    expect(failures).toEqual(["tenant bravo start failed: b failed"])

    await engine.stop()
    expect(calls).toEqual([
      "gateway.start",
      "a.start",
      "b.start",
      "b.stop",
      "a.stop",
      "gateway.stop",
    ])
  })

  it("fails start immediately when the gateway cannot start", async () => {
    const calls: string[] = []
    const tenant = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          calls.push("tenant.start")
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [tenant],
      projectStore: fakeStore([makeProject("alpha")]),
      buildTenant: noBuild,
      port: 7331,
      onLog: () => {},
      buildGateway: () => ({
        start: () => {
          calls.push("gateway.start")
          throw new Error("bind failed")
        },
        stop: async () => {
          calls.push("gateway.stop")
        },
      }),
    })

    await expect(engine.start()).rejects.toThrow("bind failed")
    expect(calls).toEqual(["gateway.start"])
  })

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

  it("continues starting later tenants after an earlier tenant fails", async () => {
    const events: string[] = []
    const a = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          events.push("a.start")
          throw new Error("a failed")
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
        },
        stop: async () => {
          events.push("b.stop")
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [a, b],
      projectStore: fakeStore([makeProject("alpha"), makeProject("bravo")]),
      buildTenant: noBuild,
      onLog: () => {},
    })

    await engine.start()
    expect(events).toEqual(["a.start", "a.stop", "b.start"])

    await engine.stop()
    expect(events).toEqual(["a.start", "a.stop", "b.start", "b.stop"])
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

  it("starts every tenant shutdown before waiting for a slow tenant", async () => {
    const stops: string[] = []
    const stopGate = Promise.withResolvers<void>()
    const stopsStarted = Promise.withResolvers<void>()
    const a = buildTenant(
      "alpha",
      fakeCodex({
        stop: async () => {
          stops.push("a")
          if (stops.length === 2) stopsStarted.resolve()
          await stopGate.promise
        },
      }),
    )
    const b = buildTenant(
      "bravo",
      fakeCodex({
        stop: async () => {
          stops.push("b")
          if (stops.length === 2) stopsStarted.resolve()
          await stopGate.promise
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

    const stopping = engine.stop()
    await stopsStarted.promise

    expect(stops).toEqual(["a", "b"])

    stopGate.resolve()
    await stopping
  })

  it("makes concurrent stop callers wait for the same shutdown", async () => {
    const stopGate = Promise.withResolvers<void>()
    const stopStarted = Promise.withResolvers<void>()
    let stopCalls = 0
    const tenant = buildTenant(
      "alpha",
      fakeCodex({
        stop: async () => {
          stopCalls++
          stopStarted.resolve()
          await stopGate.promise
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [tenant],
      projectStore: fakeStore(),
      buildTenant: noBuild,
      onLog: () => {},
    })
    await engine.start()

    const first = engine.stop()
    const second = engine.stop()
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })

    await stopStarted.promise
    expect(second).toBe(first)
    expect(secondSettled).toBe(false)
    expect(stopCalls).toBe(1)

    stopGate.resolve()
    await Promise.all([first, second])
    expect(secondSettled).toBe(true)
  })

  it("does not start later tenants when stop arrives during startup", async () => {
    const calls: string[] = []
    const startGate = Promise.withResolvers<void>()
    const a = buildTenant(
      "alpha",
      fakeCodex({
        start: async () => {
          calls.push("a.start")
          await startGate.promise
        },
        stop: async () => {
          calls.push("a.stop")
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
      projectStore: fakeStore([makeProject("alpha"), makeProject("bravo")]),
      buildTenant: noBuild,
      port: 7331,
      onLog: () => {},
      buildGateway: () => ({
        start: () => {
          calls.push("gateway.start")
        },
        stop: async () => {
          calls.push("gateway.stop")
        },
      }),
    })

    const starting = engine.start()
    await Promise.resolve()
    const stopping = engine.stop()
    startGate.resolve()

    await starting
    await stopping

    expect(calls).toEqual(["gateway.start", "a.start", "a.stop", "gateway.stop"])
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

  it("retries only the failed tenant after 30s and resets backoff after recovery", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      const projects = [makeProject("alpha"), makeProject("bravo")]
      let bravoStarts = 0
      let buildCalls = 0
      let rebuiltShouldFail = false
      const initialAlpha = buildTenant(
        "alpha",
        fakeCodex({
          start: async () => {
            throw new Error("alpha initial failure")
          },
        }),
      )
      const bravo = buildTenant(
        "bravo",
        fakeCodex({
          start: async () => {
            bravoStarts++
          },
        }),
      )
      const engine = new LeucoEngine({
        tenants: [initialAlpha, bravo],
        projectStore: fakeStore(projects),
        buildTenant: (project) => {
          buildCalls++
          return buildTenant(
            project.name,
            fakeCodex({
              start: async () => {
                if (rebuiltShouldFail) throw new Error("alpha rebuild failure")
              },
            }),
            project.id,
          )
        },
        onLog: () => {},
      })

      await engine.start()
      expect(bravoStarts).toBe(1)
      expect(engine.listProjects().map((project) => project.tenantRunning)).toEqual([false, true])

      await vi.advanceTimersByTimeAsync(29_999)
      await engine.reconcile()
      expect(buildCalls).toBe(0)

      await vi.advanceTimersByTimeAsync(1)
      await engine.reconcile()
      expect(buildCalls).toBe(1)
      expect(bravoStarts).toBe(1)
      expect(engine.listProjects().map((project) => project.tenantRunning)).toEqual([true, true])

      rebuiltShouldFail = true
      projects[0] = { ...projects[0]!, path: "/tmp/alpha-v2" }
      await engine.reconcile()
      expect(buildCalls).toBe(2)
      expect(engine.listProjects().map((project) => project.tenantRunning)).toEqual([false, true])

      rebuiltShouldFail = false
      await vi.advanceTimersByTimeAsync(29_999)
      await engine.reconcile()
      expect(buildCalls).toBe(2)

      await vi.advanceTimersByTimeAsync(1)
      await engine.reconcile()
      expect(buildCalls).toBe(3)
      expect(engine.listProjects().map((project) => project.tenantRunning)).toEqual([true, true])

      await engine.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("backs repeated tenant retries off to a five-minute ceiling", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      const project = makeProject("demo")
      let buildCalls = 0
      const initial = buildTenant(
        "demo",
        fakeCodex({
          start: async () => {
            throw new Error("initial failure")
          },
        }),
      )
      const engine = new LeucoEngine({
        tenants: [initial],
        projectStore: fakeStore([project]),
        buildTenant: () => {
          buildCalls++
          return buildTenant(
            "demo",
            fakeCodex({
              start: async () => {
                throw new Error("retry failure")
              },
            }),
          )
        },
        onLog: () => {},
      })

      await engine.start()

      for (const delay of [30_000, 60_000, 120_000, 240_000]) {
        await vi.advanceTimersByTimeAsync(delay)
        await engine.reconcile()
      }
      expect(buildCalls).toBe(4)

      await vi.advanceTimersByTimeAsync(299_999)
      await engine.reconcile()
      expect(buildCalls).toBe(4)

      await vi.advanceTimersByTimeAsync(1)
      await engine.reconcile()
      expect(buildCalls).toBe(5)

      await vi.advanceTimersByTimeAsync(300_000)
      await engine.reconcile()
      expect(buildCalls).toBe(6)

      await engine.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels pending tenant retries when the engine stops", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      let buildCalls = 0
      const project = makeProject("demo")
      const initial = buildTenant(
        "demo",
        fakeCodex({
          start: async () => {
            throw new Error("initial failure")
          },
        }),
      )
      const engine = new LeucoEngine({
        tenants: [initial],
        projectStore: fakeStore([project]),
        buildTenant: () => {
          buildCalls++
          return buildTenant("demo")
        },
        onLog: () => {},
      })

      await engine.start()
      await engine.stop()
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(buildCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rebuilds tenant when the project is renamed", async () => {
    const stops: string[] = []
    const starts: string[] = []
    const old = buildTenant(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("demo")
        },
      }),
    )

    const renamedProject = { ...makeProject("demo", true), name: "renamed" }
    const rebuilt = buildTenant(
      "renamed",
      fakeCodex({
        start: async () => {
          starts.push("renamed")
        },
      }),
      idFromName("demo"),
    )

    const engine = new LeucoEngine({
      tenants: [old],
      projectStore: fakeStore([renamedProject]),
      buildTenant: () => rebuilt,
      onLog: () => {},
    })

    await engine.reconcile()
    expect(stops).toEqual(["demo"])
    expect(starts).toEqual(["renamed"])
    expect(engine.listProjects()[0]?.tenantRunning).toBe(true)
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

  it("rebuilds a tenant when enabled Slack settings change under the same channel name", async () => {
    const stops: string[] = []
    const starts: string[] = []
    const original: Project = {
      ...makeProject("demo", true),
      channels: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "slack",
          type: "slack",
          enabled: true,
          botToken: "xoxb-original",
          appToken: "xapp-original",
          ackMode: "off",
          ackIcons: {
            progress: "hourglass_flowing_sand",
            success: "white_check_mark",
            error: "x",
          },
        },
      ],
    }
    const projects: Project[] = [original]
    const old = buildTenant(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("old")
        },
      }),
    )
    const engine = new LeucoEngine({
      tenants: [old],
      projectStore: fakeStore(projects),
      buildTenant: (project) =>
        buildTenant(
          project.name,
          fakeCodex({
            start: async () => {
              starts.push(project.name)
            },
          }),
          project.id,
        ),
      onLog: () => {},
    })
    projects[0] = {
      ...original,
      channels: original.channels.map((channel) =>
        channel.type === "slack" ? { ...channel, botToken: "xoxb-rotated" } : channel,
      ),
    }

    await engine.reconcile()

    expect(stops).toEqual(["old"])
    expect(starts).toEqual(["demo"])
    expect(engine.listProjects()[0]?.tenantRunning).toBe(true)
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
      {
        id: "00000000-0000-4000-8000-0000000alpha",
        name: "alpha",
        path: "/tmp/alpha",
        enabled: true,
        tenantRunning: true,
      },
      {
        id: "00000000-0000-4000-8000-0000000bravo",
        name: "bravo",
        path: "/tmp/bravo",
        enabled: false,
        tenantRunning: false,
      },
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
