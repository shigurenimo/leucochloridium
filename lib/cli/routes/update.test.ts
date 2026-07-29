import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { factory } from "@/cli/cli-factory"
import { updateHandler } from "@/cli/routes/update"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
import { LeucoPaths } from "@/paths/leuco-paths"

describe("update route", () => {
  let home: string
  const spawn = vi.fn(() => ({ exited: Promise.resolve(0) }))
  const order = vi.fn((left: string, right: string) =>
    left.localeCompare(right, undefined, { numeric: true }),
  )

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-update-"))
    spawn.mockClear()
    order.mockClear()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ version: "0.17.2" })),
    )
    vi.stubGlobal("Bun", { semver: { order }, spawn })
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("checks for updates without installing", async () => {
    const app = factory.createApp()
    app.command("/update", ...updateHandler)

    const response = await app.dispatch({
      path: "/update",
      body: JSON.stringify({ args: [], flags: { check: true } }),
      variables: {
        version: "0.17.1",
        daemon: new LeucoDaemon({ paths: new LeucoPaths({ home }) }),
      },
    })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe("leuco 0.17.1 -> 0.17.2 available")
    expect(spawn).not.toHaveBeenCalled()
  })

  it("installs the latest package without starting a stopped daemon", async () => {
    const app = factory.createApp()
    app.command("/update", ...updateHandler)

    const response = await app.dispatch({
      path: "/update",
      body: JSON.stringify({ args: [], flags: {} }),
      variables: {
        version: "0.17.1",
        daemon: new LeucoDaemon({ paths: new LeucoPaths({ home }) }),
      },
    })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe("leuco: updated to 0.17.2 (daemon not running)")
    expect(spawn).toHaveBeenCalledWith([process.execPath, "add", "--global", "leuco@0.17.2"], {
      stdio: ["inherit", "inherit", "inherit"],
    })
  })

  it("does not downgrade when the local version is newer than the registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ version: "0.17.1" })),
    )
    const app = factory.createApp()
    app.command("/update", ...updateHandler)

    const response = await app.dispatch({
      path: "/update",
      body: JSON.stringify({ args: [], flags: {} }),
      variables: {
        version: "0.17.2",
        daemon: new LeucoDaemon({ paths: new LeucoPaths({ home }) }),
      },
    })

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe(
      "leuco 0.17.2 is newer than published 0.17.1; not downgrading",
    )
    expect(spawn).not.toHaveBeenCalled()
  })
})
