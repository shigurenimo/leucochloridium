import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Project } from "@/config/config-schema"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoTenant } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"
import { PromptPreset } from "@/prompts/presets"
import { LeucoRuntime } from "@/runtime/runtime"

const PROJECT_ID = "00000000-0000-4000-8000-000000000000"

const makeProject = (name: string, suffix: string): Project => ({
  version: 2,
  id: `00000000-0000-4000-8000-${suffix.padStart(12, "0").slice(0, 12)}`,
  name,
  path: `/tmp/${name}`,
  enabled: true,
  conversationScope: "project",
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [PromptPreset.CORE, PromptPreset.STYLE_WORK],
  channels: [],
  mcpServers: {},
  state: { codexThreadId: null, codexThreadIds: {}, scheduleLastFiredAt: {} },
})

const sampleProject = (): Project => makeProject("demo", "0")

const fakeCodex = (onStart: () => void): CodexClientPort => ({
  start: async () => {
    onStart()
  },
  stop: async () => undefined,
  isRunning: () => true,
  startThread: async () => ({ thread: { id: "thread" } }),
  resumeThread: async (params) => ({ thread: { id: params.threadId } }),
  runTextTurn: async (_threadId, text) => text,
})

describe("LeucoRuntime", () => {
  let home = ""

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-runtime-"))
    mkdirSync("/tmp/demo", { recursive: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    rmSync(home, { recursive: true, force: true })
  })

  it("forces gpt-5.6-terra with bounded tool output in generated tenant config", () => {
    const paths = new LeucoPaths({ home })
    const store = new LeucoProjectStore({ paths })
    store.save({
      ...sampleProject(),
      mcpServers: {
        private_api: {
          command: "private-api-mcp",
          args: [],
          env: { PRIVATE_API_TOKEN: "secret-value" },
        },
      },
    })

    const configPath = join(paths.projectHome(PROJECT_ID), "config.toml")
    mkdirSync(paths.projectHome(PROJECT_ID), { recursive: true })
    writeFileSync(configPath, "stale", { mode: 0o644 })

    LeucoRuntime.build({ env: {}, home })

    const configToml = readFileSync(configPath, "utf8")
    expect(configToml).toContain('model = "gpt-5.6-terra"')
    expect(configToml).toContain('model_reasoning_effort = "xhigh"')
    expect(configToml).toContain("tool_output_token_limit = 20000")
    expect(configToml).toContain('approval_policy = "never"')
    expect(configToml).toContain('sandbox_mode = "danger-full-access"')
    expect(configToml).not.toContain("[mcp_servers.leuco]")
    expect(configToml).toContain("[mcp_servers.private_api]")
    expect(configToml).toContain('PRIVATE_API_TOKEN = "secret-value"')
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it("starts healthy tenants and supervises a project whose initial build failed", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))

    const store = new LeucoProjectStore({ paths: new LeucoPaths({ home }) })
    store.save(makeProject("healthy", "1"))
    store.save(makeProject("broken", "2"))

    const gatewayStop = vi.fn(async () => undefined)
    const gatewayServe = vi.fn(() => ({ stop: gatewayStop }))
    vi.stubGlobal("Bun", { serve: gatewayServe })

    let healthyStarts = 0
    let brokenStarts = 0
    let brokenBuildAttempts = 0
    const logs: string[] = []
    const retryAttempts: Array<number | undefined> = []
    const eventBus = new LeucoEventBus()
    eventBus.subscribe((event) => {
      if (event.type === "engine.reconcile.failed" && event.project === "broken") {
        retryAttempts.push(event.attempt)
      }
    })
    const runtime = LeucoRuntime.build({
      env: {},
      home,
      port: 7331,
      onLog: (line) => logs.push(line),
      eventBus,
      buildTenantForProject: (project) => {
        if (project.name === "broken") {
          brokenBuildAttempts++
          if (brokenBuildAttempts < 3) throw new Error("broken composition")
        }

        return new LeucoTenant({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          codex: fakeCodex(() => {
            if (project.name === "healthy") healthyStarts++
            if (project.name === "broken") brokenStarts++
          }),
          plugins: [],
          onLog: () => {},
        })
      },
    })

    try {
      await runtime.start()

      expect(gatewayServe).toHaveBeenCalledTimes(1)
      expect(healthyStarts).toBe(1)
      expect(brokenBuildAttempts).toBe(2)
      expect(brokenStarts).toBe(0)
      expect(logs.some((line) => line.includes("broken initial build failed"))).toBe(true)
      expect(retryAttempts).toEqual([undefined, 1])
      expect(
        runtime
          .getEngine()
          .listProjects()
          .map((project) => project.tenantRunning),
      ).toEqual([true, false])

      await vi.advanceTimersByTimeAsync(29_999)
      await runtime.reload()
      expect(brokenBuildAttempts).toBe(2)

      await vi.advanceTimersByTimeAsync(1)
      await runtime.reload()
      expect(brokenBuildAttempts).toBe(3)
      expect(brokenStarts).toBe(1)
      expect(
        runtime
          .getEngine()
          .listProjects()
          .map((project) => project.tenantRunning),
      ).toEqual([true, true])
    } finally {
      await runtime.stop()
    }

    expect(gatewayStop).toHaveBeenCalledTimes(1)
  })

  it("builds valid tenants when another project entry is malformed", async () => {
    const paths = new LeucoPaths({ home })
    const store = new LeucoProjectStore({ paths })
    const healthy = makeProject("healthy", "5")
    store.save(healthy)
    writeFileSync(
      paths.settingsPath(),
      JSON.stringify({
        keepAwake: true,
        projects: [healthy, { ...makeProject("broken", "6"), id: "not-a-uuid" }],
      }),
    )
    const built: string[] = []
    const logs: string[] = []

    const runtime = LeucoRuntime.build({
      env: {},
      home,
      port: 7331,
      onLog: (line) => logs.push(line),
      eventBus: new LeucoEventBus(),
      buildTenantForProject: (project) => {
        built.push(project.name)
        return new LeucoTenant({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          codex: fakeCodex(() => undefined),
          plugins: [],
          onLog: () => {},
        })
      },
    })

    expect(built).toEqual(["healthy"])
    expect(
      runtime
        .getEngine()
        .listProjects()
        .map((project) => project.name),
    ).toEqual(["healthy"])
    expect(logs.some((line) => line.includes("project broken is invalid and was skipped"))).toBe(
      true,
    )
    expect(JSON.parse(readFileSync(paths.settingsPath(), "utf8")).projects).toHaveLength(2)
    await runtime.stop()
  })

  it("preserves a tenant-specific auth file instead of replacing it with a symlink", async () => {
    const paths = new LeucoPaths({ home })
    const store = new LeucoProjectStore({ paths })
    const project = makeProject("tenant-auth", "3")
    store.save(project)

    mkdirSync(paths.projectHome(project.id), { recursive: true })
    mkdirSync(join(home, ".codex"), { recursive: true })
    writeFileSync(paths.codexAuthPath(), "shared credentials")
    const tenantAuthPath = join(paths.projectHome(project.id), "auth.json")
    writeFileSync(tenantAuthPath, "tenant credentials")

    const runtime = LeucoRuntime.build({
      env: {},
      home,
      port: 7331,
      eventBus: new LeucoEventBus(),
    })

    expect(lstatSync(tenantAuthPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(tenantAuthPath, "utf8")).toBe("tenant credentials")
    await runtime.stop()
  })

  it("writes MCP strings and inline-table values without raw TOML control characters", async () => {
    const paths = new LeucoPaths({ home })
    const store = new LeucoProjectStore({ paths })
    const project: Project = {
      ...makeProject("toml", "4"),
      mcpServers: {
        extra: {
          command: "line\nbreak",
          args: ["tab\tvalue"],
          env: { SAFE_KEY: "value\r\nnext" },
        },
      },
    }
    store.save(project)

    const runtime = LeucoRuntime.build({
      env: {},
      home,
      port: 7331,
      eventBus: new LeucoEventBus(),
    })
    const config = readFileSync(join(paths.projectHome(project.id), "config.toml"), "utf8")

    expect(config).toContain("tool_output_token_limit = 20000")
    expect(config).toContain('command = "line\\nbreak"')
    expect(config).toContain('args = ["tab\\tvalue"]')
    expect(config).toContain('env = { SAFE_KEY = "value\\r\\nnext" }')
    await runtime.stop()
  })
})
