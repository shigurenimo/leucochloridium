import { describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
import { PromptPreset } from "@/prompts/presets"
import { removeProjectSafely } from "@/projects/remove-project-safely"

const project = (enabled = true): Project => ({
  version: 2,
  id: "00000000-0000-4000-8000-000000000001",
  name: "demo",
  path: "/tmp/demo",
  enabled,
  conversationScope: "project",
  useCommonInstructions: true,
  model: null,
  developerInstructions: null,
  prompts: [PromptPreset.CORE],
  channels: [],
  mcpServers: {},
  state: { codexThreadId: null, codexThreadIds: {}, scheduleLastFiredAt: {} },
})

const status = (running: boolean) => ({
  pid: running ? 101 : null,
  isRunning: running,
  pidPath: "/tmp/leuco.pid",
  logPath: "/tmp/leuco.log",
})

describe("removeProjectSafely", () => {
  it("disables, drains, removes, then restarts in strict order", async () => {
    const calls: string[] = []
    const updatedProjects: Project[] = []
    let running = true
    const daemon = {
      status: () => {
        calls.push("status")
        return status(running)
      },
      reload: () => {
        calls.push("reload")
        return { signalled: true, pid: 101 }
      },
      stop: () => {
        calls.push("stop")
        running = false
        return { stopped: true, pid: 101 }
      },
    }
    const store = {
      updateProject: (_projectId: string, transform: (current: Project) => Project) => {
        const updated = transform({
          ...project(),
          developerInstructions: "concurrent update",
        })
        updatedProjects.push(updated)
        calls.push(`update:${updated.enabled}`)
        return updated
      },
      remove: () => {
        calls.push("remove")
      },
    }

    const result = await removeProjectSafely({
      project: project(false),
      daemon,
      store,
      restart: async () => {
        calls.push("restart")
        return { mode: "launchd", label: "io.leuco.daemon", logPath: "/tmp/leuco.log" }
      },
    })

    expect(result).toEqual({
      daemonWasRunning: true,
      restarted: {
        mode: "launchd",
        label: "io.leuco.daemon",
        logPath: "/tmp/leuco.log",
      },
    })
    expect(updatedProjects).toMatchObject([
      {
        enabled: false,
        developerInstructions: "concurrent update",
      },
    ])
    expect(calls).toEqual([
      "status",
      "update:false",
      "reload",
      "status",
      "stop",
      "status",
      "remove",
      "restart",
    ])
  })

  it("does not remove files when the daemon remains alive", async () => {
    const calls: string[] = []
    const daemon = {
      status: () => {
        calls.push("status")
        return status(true)
      },
      reload: () => {
        calls.push("reload")
        return { signalled: true, pid: 101 }
      },
      stop: () => {
        calls.push("stop")
        return { stopped: false, pid: 101 }
      },
    }
    const store = {
      updateProject: () => {
        calls.push("update")
        return project(false)
      },
      remove: () => {
        calls.push("remove")
      },
    }

    const result = await removeProjectSafely({
      project: project(),
      daemon,
      store,
      restart: async () => {
        calls.push("restart")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(result).toEqual(
      new Error(
        "daemon did not stop; project remains registered but disabled: daemon pid 101 did not stop",
      ),
    )
    expect(calls).toEqual(["status", "update", "reload", "status", "stop", "status"])
  })

  it("removes without reload or restart when the daemon was already stopped", async () => {
    const calls: string[] = []

    const result = await removeProjectSafely({
      project: project(),
      daemon: {
        status: () => {
          calls.push("status")
          return status(false)
        },
        reload: () => {
          calls.push("reload")
          return { signalled: false, pid: null }
        },
        stop: () => {
          calls.push("stop")
          return { stopped: false, pid: null }
        },
      },
      store: {
        updateProject: () => {
          calls.push("update")
          return project(false)
        },
        remove: () => {
          calls.push("remove")
        },
      },
      restart: async () => {
        calls.push("restart")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(result).toEqual({ daemonWasRunning: false, restarted: null })
    expect(calls).toEqual(["status", "update", "status", "remove"])
  })

  it("restarts the daemon even when removing project files fails", async () => {
    const calls: string[] = []
    let running = true

    const result = await removeProjectSafely({
      project: project(),
      daemon: {
        status: () => {
          calls.push("status")
          return status(running)
        },
        reload: () => {
          calls.push("reload")
          return { signalled: true, pid: 101 }
        },
        stop: () => {
          calls.push("stop")
          running = false
          return { stopped: true, pid: 101 }
        },
      },
      store: {
        updateProject: () => {
          calls.push("update")
          return project(false)
        },
        remove: () => {
          calls.push("remove")
          throw new Error("disk denied")
        },
      },
      restart: async () => {
        calls.push("restart")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(result).toEqual(
      new Error("project removal did not complete, but daemon was restarted: disk denied"),
    )
    expect(calls).toEqual([
      "status",
      "update",
      "reload",
      "status",
      "stop",
      "status",
      "remove",
      "restart",
    ])
  })

  it("does not stop the daemon when persisting the disabled state fails", async () => {
    const calls: string[] = []

    const result = await removeProjectSafely({
      project: project(),
      daemon: {
        status: () => {
          calls.push("status")
          return status(true)
        },
        reload: () => {
          calls.push("reload")
          return { signalled: true, pid: 101 }
        },
        stop: () => {
          calls.push("stop")
          return { stopped: true, pid: 101 }
        },
      },
      store: {
        updateProject: () => {
          calls.push("update")
          throw new Error("settings read-only")
        },
        remove: () => {
          calls.push("remove")
        },
      },
      restart: async () => {
        calls.push("restart")
        return { mode: "detached", pid: 202, logPath: "/tmp/leuco.log" }
      },
    })

    expect(result).toEqual(
      new Error("failed to disable project before removal: settings read-only"),
    )
    expect(calls).toEqual(["status", "update"])
  })
})
