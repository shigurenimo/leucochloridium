import { describe, expect, it, vi } from "vitest"
import type { Project } from "@/config/config-schema"
import { LeucoProjectSupervisor } from "@/project/project-supervisor"
import { PromptPreset } from "@/prompts/presets"
import { LeucoProjectRuntime } from "@/project/project-runtime"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { Connector } from "@/connectors/connector"
import type { LeucoProjectStore } from "@/projects/project-store"

const fakeCodex = (overrides: Partial<CodexClientPort> = {}): CodexClientPort => ({
  start: async () => undefined,
  stop: async () => undefined,
  isRunning: () => true,
  startThread: async () => ({ thread: { id: "tx" } }),
  resumeThread: async (params) => ({ thread: { id: params.threadId } }),
  runTextTurn: async (_id, text) => text,
  interruptTurn: async () => ({ status: "not-active" }),
  ...overrides,
})

const fakeConnector = (name: string, overrides: Partial<Connector> = {}): Connector => ({
  name,
  start: async () => undefined,
  stop: async () => undefined,
  getIdentity: () => ({ name, type: "slack", botUserId: null }),
  ...overrides,
})

const idFromName = (name: string): string =>
  `00000000-0000-4000-8000-${name.padStart(12, "0").slice(0, 12)}`

const buildProjectRuntime = (
  projectName: string,
  codex: CodexClientPort = fakeCodex(),
  projectId?: string,
) =>
  new LeucoProjectRuntime({
    projectId: projectId ?? idFromName(projectName),
    projectName,
    projectPath: `/tmp/${projectName}`,
    codex,
    connectors: [],
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

const noBuild = (): LeucoProjectRuntime => {
  throw new Error("buildProjectRuntime not configured")
}

const noConnectorBuild = (): Connector => {
  throw new Error("buildProjectConnector not configured")
}

const makeProject = (name: string, enabled = true): Project => ({
  version: 3,
  id: `00000000-0000-4000-8000-${name.padStart(12, "0").slice(0, 12)}`,
  name,
  path: `/tmp/${name}`,
  enabled,
  conversationScope: "project",
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [PromptPreset.CORE, PromptPreset.STYLE_WORK, PromptPreset.STYLE_SLACK],
  connectors: [],
  mcpServers: {},
})

describe("LeucoProjectSupervisor.start / stop", () => {
  it("starts and stops project runtimes in order", async () => {
    const calls: string[] = []
    const a = buildProjectRuntime(
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
    const b = buildProjectRuntime(
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
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })

    await supervisor.start()
    await supervisor.stop()

    expect(calls).toEqual(["a.start", "b.start", "a.stop", "b.stop"])
  })

  it("keeps healthy project runtimes running when another fails to start", async () => {
    const calls: string[] = []
    const eventLog = new LeucoEventLog()
    const a = buildProjectRuntime(
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
    const b = buildProjectRuntime(
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
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore(projects),
      buildProjectRuntime: noBuild,
      onLog: () => {},
      eventLog,
    })

    await supervisor.start()

    expect(calls).toEqual(["a.start", "b.start", "b.stop"])
    expect(supervisor.listProjects().map((project) => project.isRunning)).toEqual([true, false])
    expect(
      eventLog
        .query({ type: "supervisor.reconcile.failed" })
        .map((entry) => entry.event)
        .filter((event) => event.type === "supervisor.reconcile.failed")
        .map((event) => event.reason),
    ).toEqual(["project runtime bravo start failed: b failed"])

    await supervisor.stop()
    expect(calls).toEqual(["a.start", "b.start", "b.stop", "a.stop"])
  })

  it("starts each runtime in order", async () => {
    const calls: string[] = []
    const a = buildProjectRuntime(
      "alpha",
      fakeCodex({
        start: async () => {
          calls.push("a.start")
        },
      }),
    )
    const b = buildProjectRuntime(
      "bravo",
      fakeCodex({
        start: async () => {
          calls.push("b.start")
        },
      }),
    )

    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    await supervisor.start()

    expect(calls).toEqual(["a.start", "b.start"])
  })

  it("stops each runtime on supervisor.stop()", async () => {
    const stops: string[] = []
    const a = buildProjectRuntime(
      "alpha",
      fakeCodex({
        stop: async () => {
          stops.push("a")
        },
      }),
    )
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    await supervisor.start()
    await supervisor.stop()

    expect(stops).toEqual(["a"])
  })

  it("continues starting later runtimes after an earlier runtime fails", async () => {
    const events: string[] = []
    const a = buildProjectRuntime(
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
    const b = buildProjectRuntime(
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
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore([makeProject("alpha"), makeProject("bravo")]),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })

    await supervisor.start()
    expect(events).toEqual(["a.start", "a.stop", "b.start"])

    await supervisor.stop()
    expect(events).toEqual(["a.start", "a.stop", "b.start", "b.stop"])
  })

  it("keeps draining runtimes even when one fails to stop", async () => {
    const stops: string[] = []
    const a = buildProjectRuntime(
      "alpha",
      fakeCodex({
        stop: async () => {
          stops.push("a")
          throw new Error("a stop boom")
        },
      }),
    )
    const b = buildProjectRuntime(
      "bravo",
      fakeCodex({
        stop: async () => {
          stops.push("b")
        },
      }),
    )
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    await supervisor.start()
    await supervisor.stop()

    expect(stops).toEqual(["a", "b"])
  })

  it("starts every runtime shutdown before waiting for a slow runtime", async () => {
    const stops: string[] = []
    const stopGate = Promise.withResolvers<void>()
    const stopsStarted = Promise.withResolvers<void>()
    const a = buildProjectRuntime(
      "alpha",
      fakeCodex({
        stop: async () => {
          stops.push("a")
          if (stops.length === 2) stopsStarted.resolve()
          await stopGate.promise
        },
      }),
    )
    const b = buildProjectRuntime(
      "bravo",
      fakeCodex({
        stop: async () => {
          stops.push("b")
          if (stops.length === 2) stopsStarted.resolve()
          await stopGate.promise
        },
      }),
    )
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    await supervisor.start()

    const stopping = supervisor.stop()
    await stopsStarted.promise

    expect(stops).toEqual(["a", "b"])

    stopGate.resolve()
    await stopping
  })

  it("makes concurrent stop callers wait for the same shutdown", async () => {
    const stopGate = Promise.withResolvers<void>()
    const stopStarted = Promise.withResolvers<void>()
    let stopCalls = 0
    const runtime = buildProjectRuntime(
      "alpha",
      fakeCodex({
        stop: async () => {
          stopCalls++
          stopStarted.resolve()
          await stopGate.promise
        },
      }),
    )
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [runtime],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    await supervisor.start()

    const first = supervisor.stop()
    const second = supervisor.stop()
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

  it("does not start later runtimes when stop arrives during startup", async () => {
    const calls: string[] = []
    const startGate = Promise.withResolvers<void>()
    const a = buildProjectRuntime(
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
    const b = buildProjectRuntime(
      "bravo",
      fakeCodex({
        start: async () => {
          calls.push("b.start")
        },
      }),
    )
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore([makeProject("alpha"), makeProject("bravo")]),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })

    const starting = supervisor.start()
    await Promise.resolve()
    const stopping = supervisor.stop()
    startGate.resolve()

    await starting
    await stopping

    expect(calls).toEqual(["a.start", "a.stop"])
  })
})

describe("LeucoProjectSupervisor.reconcile", () => {
  it("stops runtimes whose project has been disabled", async () => {
    const stops: string[] = []
    const a = buildProjectRuntime(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("demo")
        },
      }),
    )
    const projects = [makeProject("demo", false)]
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a],
      projectStore: fakeStore(projects),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })

    await supervisor.reconcile()
    expect(stops).toEqual(["demo"])
    expect(supervisor.listProjects()[0]?.isRunning).toBe(false)
  })

  it("starts runtimes whose project is newly enabled", async () => {
    const starts: string[] = []
    const built = buildProjectRuntime(
      "demo",
      fakeCodex({
        start: async () => {
          starts.push("demo")
        },
      }),
    )
    const projects = [makeProject("demo", true)]
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [],
      projectStore: fakeStore(projects),
      buildProjectRuntime: () => built,
      onLog: () => {},
    })

    await supervisor.reconcile()
    expect(starts).toEqual(["demo"])
    expect(supervisor.listProjects()[0]?.isRunning).toBe(true)
  })

  it("serializes concurrent reconcile() calls so a runtime is not double-started", async () => {
    const starts: string[] = []
    let releaseFirstStart: () => void = () => {}
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve
    })

    let buildCalls = 0
    const built = buildProjectRuntime(
      "demo",
      fakeCodex({
        start: async () => {
          starts.push("demo")
          if (starts.length === 1) await firstStartGate
        },
      }),
    )

    const projects = [makeProject("demo", true)]
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [],
      projectStore: fakeStore(projects),
      buildProjectRuntime: () => {
        buildCalls++
        return built
      },
      onLog: () => {},
    })

    const first = supervisor.reconcile()
    const second = supervisor.reconcile()

    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(starts).toEqual(["demo"])

    releaseFirstStart()
    await first
    await second

    expect(starts).toEqual(["demo"])
    expect(buildCalls).toBe(1)
  })

  it("retries only the failed runtime after 30s and resets backoff after recovery", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      const projects = [makeProject("alpha"), makeProject("bravo")]
      let bravoStarts = 0
      let buildCalls = 0
      let rebuiltShouldFail = false
      const initialAlpha = buildProjectRuntime(
        "alpha",
        fakeCodex({
          start: async () => {
            throw new Error("alpha initial failure")
          },
        }),
      )
      const bravo = buildProjectRuntime(
        "bravo",
        fakeCodex({
          start: async () => {
            bravoStarts++
          },
        }),
      )
      const supervisor = new LeucoProjectSupervisor({
        buildProjectConnector: noConnectorBuild,
        runtimes: [initialAlpha, bravo],
        projectStore: fakeStore(projects),
        buildProjectRuntime: (project) => {
          buildCalls++
          return buildProjectRuntime(
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

      await supervisor.start()
      expect(bravoStarts).toBe(1)
      expect(supervisor.listProjects().map((project) => project.isRunning)).toEqual([false, true])

      await vi.advanceTimersByTimeAsync(29_999)
      await supervisor.reconcile()
      expect(buildCalls).toBe(0)

      await vi.advanceTimersByTimeAsync(1)
      await supervisor.reconcile()
      expect(buildCalls).toBe(1)
      expect(bravoStarts).toBe(1)
      expect(supervisor.listProjects().map((project) => project.isRunning)).toEqual([true, true])

      rebuiltShouldFail = true
      projects[0] = { ...projects[0]!, path: "/tmp/alpha-v2" }
      await supervisor.reconcile()
      expect(buildCalls).toBe(2)
      expect(supervisor.listProjects().map((project) => project.isRunning)).toEqual([false, true])

      rebuiltShouldFail = false
      await vi.advanceTimersByTimeAsync(29_999)
      await supervisor.reconcile()
      expect(buildCalls).toBe(2)

      await vi.advanceTimersByTimeAsync(1)
      await supervisor.reconcile()
      expect(buildCalls).toBe(3)
      expect(supervisor.listProjects().map((project) => project.isRunning)).toEqual([true, true])

      await supervisor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("backs repeated runtime retries off to a five-minute ceiling", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      const project = makeProject("demo")
      let buildCalls = 0
      const initial = buildProjectRuntime(
        "demo",
        fakeCodex({
          start: async () => {
            throw new Error("initial failure")
          },
        }),
      )
      const supervisor = new LeucoProjectSupervisor({
        buildProjectConnector: noConnectorBuild,
        runtimes: [initial],
        projectStore: fakeStore([project]),
        buildProjectRuntime: () => {
          buildCalls++
          return buildProjectRuntime(
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

      await supervisor.start()

      for (const delay of [30_000, 60_000, 120_000, 240_000]) {
        await vi.advanceTimersByTimeAsync(delay)
        await supervisor.reconcile()
      }
      expect(buildCalls).toBe(4)

      await vi.advanceTimersByTimeAsync(299_999)
      await supervisor.reconcile()
      expect(buildCalls).toBe(4)

      await vi.advanceTimersByTimeAsync(1)
      await supervisor.reconcile()
      expect(buildCalls).toBe(5)

      await vi.advanceTimersByTimeAsync(300_000)
      await supervisor.reconcile()
      expect(buildCalls).toBe(6)

      await supervisor.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it("cancels pending runtime retries when the supervisor stops", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    try {
      let buildCalls = 0
      const project = makeProject("demo")
      const initial = buildProjectRuntime(
        "demo",
        fakeCodex({
          start: async () => {
            throw new Error("initial failure")
          },
        }),
      )
      const supervisor = new LeucoProjectSupervisor({
        buildProjectConnector: noConnectorBuild,
        runtimes: [initial],
        projectStore: fakeStore([project]),
        buildProjectRuntime: () => {
          buildCalls++
          return buildProjectRuntime("demo")
        },
        onLog: () => {},
      })

      await supervisor.start()
      await supervisor.stop()
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(buildCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("rebuilds runtime when the project is renamed", async () => {
    const stops: string[] = []
    const starts: string[] = []
    const old = buildProjectRuntime(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("demo")
        },
      }),
    )

    const renamedProject = { ...makeProject("demo", true), name: "renamed" }
    const rebuilt = buildProjectRuntime(
      "renamed",
      fakeCodex({
        start: async () => {
          starts.push("renamed")
        },
      }),
      idFromName("demo"),
    )

    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [old],
      projectStore: fakeStore([renamedProject]),
      buildProjectRuntime: () => rebuilt,
      onLog: () => {},
    })

    await supervisor.reconcile()
    expect(stops).toEqual(["demo"])
    expect(starts).toEqual(["renamed"])
    expect(supervisor.listProjects()[0]?.isRunning).toBe(true)
  })

  it("keeps runtimes that are still enabled and present", async () => {
    const stops: string[] = []
    const a = buildProjectRuntime(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("demo")
        },
      }),
    )
    const projects = [makeProject("demo", true)]
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a],
      projectStore: fakeStore(projects),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })

    await supervisor.reconcile()
    expect(stops).toEqual([])
  })

  it("rebuilds a runtime when enabled Slack settings change under the same channel name", async () => {
    const stops: string[] = []
    const starts: string[] = []
    const original: Project = {
      ...makeProject("demo", true),
      connectors: [
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
    const old = buildProjectRuntime(
      "demo",
      fakeCodex({
        stop: async () => {
          stops.push("old")
        },
      }),
    )
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [old],
      projectStore: fakeStore(projects),
      buildProjectRuntime: (project) =>
        buildProjectRuntime(
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
      connectors: original.connectors.map((channel) =>
        channel.type === "slack" ? { ...channel, botToken: "xoxb-rotated" } : channel,
      ),
    }

    await supervisor.reconcile()

    expect(stops).toEqual(["old"])
    expect(starts).toEqual(["demo"])
    expect(supervisor.listProjects()[0]?.isRunning).toBe(true)
  })
})

describe("LeucoProjectSupervisor connector control", () => {
  it("builds a fresh connector from current settings and replaces only that connector", async () => {
    const calls: string[] = []
    const project: Project = {
      ...makeProject("demo"),
      connectors: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "slack",
          type: "slack",
          enabled: true,
          botToken: "xoxb-current",
          appToken: "xapp-current",
          ackMode: "mention",
          ackIcons: {
            progress: "hourglass_flowing_sand",
            success: "white_check_mark",
            error: "x",
          },
        },
      ],
    }
    const current = fakeConnector("slack", {
      stop: async () => {
        calls.push("current.stop")
      },
    })
    const replacement = fakeConnector("slack", {
      start: async () => {
        calls.push("replacement.start")
      },
      stop: async () => {
        calls.push("replacement.stop")
      },
    })
    const runtime = new LeucoProjectRuntime({
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      codex: fakeCodex(),
      connectors: [current],
      onLog: () => {},
    })
    const buildConnector = vi.fn(() => replacement)
    const supervisor = new LeucoProjectSupervisor({
      runtimes: [runtime],
      projectStore: fakeStore([project]),
      buildProjectRuntime: noBuild,
      buildProjectConnector: buildConnector,
      onLog: () => {},
    })

    await supervisor.start()
    await supervisor.restartConnector(project.id, "slack")

    expect(buildConnector).toHaveBeenCalledWith(project, "slack")
    expect(calls).toEqual(["current.stop", "replacement.start"])

    await supervisor.stop()
    expect(calls).toEqual(["current.stop", "replacement.start", "replacement.stop"])
  })
})

describe("LeucoProjectSupervisor introspection", () => {
  it("listThreads exposes the project's single codex thread once a turn has run", async () => {
    const a = buildProjectRuntime(
      "demo",
      fakeCodex({ startThread: async () => ({ thread: { id: "tA" } }) }),
    )
    await a.runTextTurn("k1", "x")

    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    expect(supervisor.listThreads()).toEqual([
      { project: "demo", threadKey: "demo", threadId: "tA" },
    ])
  })

  it("listProjects returns enabled state plus running flag for each project", () => {
    const projects = [makeProject("alpha", true), makeProject("bravo", false)]
    const a = buildProjectRuntime("alpha")
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a],
      projectStore: fakeStore(projects),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })

    const summary = supervisor.listProjects()
    expect(summary).toEqual([
      {
        id: "00000000-0000-4000-8000-0000000alpha",
        name: "alpha",
        path: "/tmp/alpha",
        enabled: true,
        isRunning: true,
      },
      {
        id: "00000000-0000-4000-8000-0000000bravo",
        name: "bravo",
        path: "/tmp/bravo",
        enabled: false,
        isRunning: false,
      },
    ])
  })

  it("isCodexRunning is true when any runtime is running", () => {
    const a = buildProjectRuntime("alpha", fakeCodex({ isRunning: () => false }))
    const b = buildProjectRuntime("bravo", fakeCodex({ isRunning: () => true }))
    const supervisor = new LeucoProjectSupervisor({
      buildProjectConnector: noConnectorBuild,
      runtimes: [a, b],
      projectStore: fakeStore(),
      buildProjectRuntime: noBuild,
      onLog: () => {},
    })
    expect(supervisor.isCodexRunning()).toBe(true)
  })
})
