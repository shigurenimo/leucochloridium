import { describe, expect, it, vi } from "vitest"
import type { Project } from "@/config/config-schema"
import { stopProjectTenant } from "@/cli/utils/stop-project-tenant"
import { PromptPreset } from "@/engine/prompt-presets"

const PROJECT_ID = "00000000-0000-4000-8000-000000000000"

const project = (): Project => ({
  version: 2,
  id: PROJECT_ID,
  name: "demo",
  path: "/tmp/demo",
  enabled: true,
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [PromptPreset.CORE, PromptPreset.COMMUNICATION, PromptPreset.COMMUNICATION_SLACK],
  channels: [],
  mcpServers: {},
  state: { codexThreadId: null, scheduleLastFiredAt: {} },
})

describe("stopProjectTenant", () => {
  it("disables and waits for a running tenant", async () => {
    let current = project()
    const reload = vi.fn(() => ({ signalled: true, pid: 10 }))
    const result = await stopProjectTenant({
      projectId: PROJECT_ID,
      store: {
        updateProject: (_id, transform) => {
          current = transform(current)
          return current
        },
      },
      daemon: { status: () => daemonStatus(true), reload },
      waitForDown: async () => true,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(current.enabled).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("restores enabled state when shutdown cannot be confirmed", async () => {
    let current = project()
    const reload = vi.fn(() => ({ signalled: true, pid: 10 }))
    const result = await stopProjectTenant({
      projectId: PROJECT_ID,
      store: {
        updateProject: (_id, transform) => {
          current = transform(current)
          return current
        },
      },
      daemon: { status: () => daemonStatus(true), reload },
      waitForDown: async () => false,
    })

    expect(result).toBeInstanceOf(Error)
    expect(current.enabled).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("does not enable a project that was already disabled", async () => {
    let current = { ...project(), enabled: false }
    const reload = vi.fn(() => ({ signalled: true, pid: 10 }))
    const result = await stopProjectTenant({
      projectId: PROJECT_ID,
      store: {
        updateProject: (_id, transform) => {
          current = transform(current)
          return current
        },
      },
      daemon: { status: () => daemonStatus(true), reload },
      waitForDown: async () => false,
    })

    expect(result).toBeInstanceOf(Error)
    expect(current.enabled).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("does not rewrite config when the daemon is stopped", async () => {
    const updateProject = vi.fn()
    const reload = vi.fn()
    const result = await stopProjectTenant({
      projectId: PROJECT_ID,
      store: { updateProject },
      daemon: { status: () => daemonStatus(false), reload },
      waitForDown: async () => true,
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(updateProject).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})

const daemonStatus = (isRunning: boolean) => ({
  pid: isRunning ? 10 : null,
  isRunning,
  pidPath: "/tmp/pid",
  logPath: "/tmp/log",
})
