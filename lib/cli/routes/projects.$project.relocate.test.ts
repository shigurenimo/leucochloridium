import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { factory } from "@/cli/cli-factory"
import { projectsRelocateHandler } from "@/cli/routes/projects.$project.relocate"
import type { DaemonStatus } from "@/daemon/leuco-daemon"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
import { LeucoPaths } from "@/paths/leuco-paths"

const doubles = vi.hoisted(() => ({
  listProjects: vi.fn(),
  resolveProject: vi.fn(),
  updateProject: vi.fn(),
  startDaemon: vi.fn(),
  stopDaemonAndVerify: vi.fn(),
  supervisionWarning: vi.fn(),
}))

vi.mock("@/projects/project-store", () => ({
  LeucoProjectStore: class {
    list() {
      return doubles.listProjects()
    }

    updateProject(projectId: string, transform: (project: unknown) => unknown) {
      return doubles.updateProject(projectId, transform)
    }
  },
}))

vi.mock("@/cli/utils/lookup-config", () => ({
  resolveProject: doubles.resolveProject,
}))

vi.mock("@/daemon/daemon-control", () => ({
  daemonSupervisionWarning: doubles.supervisionWarning,
  startDaemon: doubles.startDaemon,
  stopDaemonAndVerify: doubles.stopDaemonAndVerify,
}))

class RunningDaemon extends LeucoDaemon {
  override status(): DaemonStatus {
    return {
      pid: 101,
      isRunning: true,
      pidPath: this.getPidPath(),
      logPath: this.getLogPath(),
    }
  }
}

describe("projects relocate route", () => {
  let home = ""

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-relocate-route-"))
    doubles.listProjects.mockReturnValue([])
    doubles.supervisionWarning.mockReturnValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  it("drains the daemon and restores it through launchd after the move", async () => {
    const calls: string[] = []
    const updatedProjects: unknown[] = []
    const sourcePath = join(home, "old-project")
    const targetPath = join(home, "new-project")
    mkdirSync(sourcePath)
    const project = {
      version: 2,
      id: "00000000-0000-4000-8000-000000000001",
      name: "old-project",
      path: sourcePath,
      enabled: true,
      conversationScope: "project",
      useCommonInstructions: true,
      model: null,
      developerInstructions: null,
      prompts: ["CORE"],
      channels: [],
      mcpServers: {},
      state: { codexThreadId: null, codexThreadIds: {}, scheduleLastFiredAt: {} },
    }
    doubles.resolveProject.mockReturnValue(project)
    doubles.stopDaemonAndVerify.mockImplementation(() => {
      calls.push("stop")
      return { wasRunning: true, pid: 101 }
    })
    doubles.updateProject.mockImplementation((_projectId, transform) => {
      calls.push("update")
      const updated = transform({
        ...project,
        developerInstructions: "concurrent update",
      })
      updatedProjects.push(updated)
      return updated
    })
    doubles.startDaemon.mockImplementation(async () => {
      calls.push("start")
      return {
        mode: "launchd",
        label: "io.leuco.daemon",
        logPath: "/tmp/leuco.log",
      }
    })

    const daemon = new RunningDaemon({ paths: new LeucoPaths({ home }) })
    const app = factory.createApp()
    app.use(async (context, next) => {
      context.set("daemon", daemon)
      context.set("cwd", home)
      context.set("binPath", "/tmp/leuco")
      context.set("envFiles", {
        local: { path: "/tmp/.env.local", loaded: false, keys: [] },
        base: { path: "/tmp/.env", loaded: false, keys: [] },
      })
      context.set("version", "test")
      await next()
    })
    app.post("/projects/:project/relocate", ...projectsRelocateHandler)

    const response = await app.request("/projects/old-project/relocate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [targetPath], flags: {} }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("daemon restarted via launchd (io.leuco.daemon)")
    expect(calls).toEqual(["stop", "update", "start"])
    expect(updatedProjects).toMatchObject([
      {
        path: targetPath,
        developerInstructions: "concurrent update",
      },
    ])
    expect(existsSync(sourcePath)).toBe(false)
    expect(existsSync(targetPath)).toBe(true)
  })
})
