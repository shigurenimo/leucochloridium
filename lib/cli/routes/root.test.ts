import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { factory } from "@/cli/cli-factory"
import { rootHandler } from "@/cli/routes/root"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
import { LeucoPaths } from "@/paths/leuco-paths"

const doubles = vi.hoisted(() => ({
  formatStatus: vi.fn(),
  startDaemon: vi.fn(),
  supervisionWarning: vi.fn(),
}))

vi.mock("@/cli/utils/format-status", () => ({
  formatStatus: doubles.formatStatus,
}))

vi.mock("@/daemon/daemon-control", () => ({
  daemonSupervisionWarning: doubles.supervisionWarning,
  startDaemon: doubles.startDaemon,
}))

describe("root route", () => {
  let home = ""

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-root-route-"))
    doubles.formatStatus.mockReturnValue({ text: "running: false", isRunning: false })
    doubles.startDaemon.mockResolvedValue({
      mode: "launchd",
      label: "io.leuco.daemon",
      logPath: "/tmp/leuco.log",
    })
    doubles.supervisionWarning.mockReturnValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(home, { recursive: true, force: true })
  })

  it("routes a bare invocation through managed daemon startup", async () => {
    const daemon = new LeucoDaemon({ paths: new LeucoPaths({ home }) })
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
    app.command("/", ...rootHandler)

    const response = await app.dispatch({ path: "/" })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(
      "leuco: started via launchd (io.leuco.daemon)\nlog: /tmp/leuco.log",
    )
    expect(doubles.startDaemon).toHaveBeenCalledWith({
      daemon,
      binPath: "/tmp/leuco",
      env: process.env,
    })
  })
})
