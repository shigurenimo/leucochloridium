import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { factory } from "@/cli/cli-factory"
import { doctorHandler } from "@/cli/routes/doctor"
import { LeucoDaemon } from "@/daemon/leuco-daemon"

const doubles = vi.hoisted(() => ({
  basePath: "/__leuco_doctor_test_missing__",
  listRunnable: vi.fn(),
}))

vi.mock("@/paths/leuco-paths", () => ({
  LeucoPaths: class {
    daemonPidPath(): string {
      return `${doubles.basePath}/daemon/pid`
    }

    daemonLogPath(): string {
      return `${doubles.basePath}/daemon/log`
    }

    settingsPath(): string {
      return `${doubles.basePath}/settings.json`
    }

    projectHome(projectId: string): string {
      return `${doubles.basePath}/projects/${projectId}/.codex`
    }
  },
}))

vi.mock("@/projects/project-store", () => ({
  LeucoProjectStore: class {
    listRunnable(): unknown {
      return doubles.listRunnable()
    }
  },
}))

describe("doctor route", () => {
  beforeEach(() => {
    doubles.listRunnable.mockReturnValue({
      projects: [],
      issues: [{ index: 2, project: "broken", error: "id: invalid UUID" }],
    })
    vi.stubGlobal("Bun", {
      spawnSync: vi.fn(() => ({
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        exitCode: 0,
      })),
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it("reports per-project schema failures without discarding the reason", async () => {
    const app = factory.createApp()
    app.use(async (context, next) => {
      context.set("daemon", new LeucoDaemon())
      context.set("cwd", "/tmp")
      context.set("binPath", "/tmp/leuco")
      context.set("envFiles", {
        local: { path: "/tmp/.env.local", loaded: false, keys: [] },
        base: { path: "/tmp/.env", loaded: false, keys: [] },
      })
      context.set("version", "test")
      await next()
    })
    app.post("/doctor", ...doctorHandler)

    const response = await app.request("/doctor", { method: "POST" })
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("x-cli-exit")).toBe("1")
    expect(body).toContain("invalid project entries found")
    expect(body).toContain("projects[2] (broken): id: invalid UUID")
  })
})
