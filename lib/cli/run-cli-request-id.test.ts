import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { runCli } from "@/cli/run-cli"

const fixture = vi.hoisted(() => ({
  start: vi.fn(),
  repair: vi.fn(),
  diagnose: vi.fn(),
  output: vi.fn(),
}))
vi.mock("@/storage/node-leuco-store", async () => {
  const memory = await import("@/storage/memory-leuco-store")
  return {
    NodeLeucoStore: class extends memory.MemoryLeucoStore {
      constructor() {
        super()
      }
      ensureHome() {}
    },
  }
})
vi.mock("@/daemon/start-daemon", () => ({ startDaemon: fixture.start }))
vi.mock("@/maintenance/repair-runtime", () => ({ repairRuntime: fixture.repair }))
vi.mock("@/cli/diagnose-runtime", () => ({ diagnoseRuntime: fixture.diagnose }))
vi.mock("@/cli/write-cli-output", () => ({ writeCliOutput: fixture.output }))
const home = "/memory/leuco-home"
beforeEach(() => {
  fixture.start.mockReset().mockResolvedValue({ running: true })
  fixture.repair.mockReset().mockResolvedValue({ actions: [] })
  fixture.diagnose.mockReset().mockResolvedValue({ healthy: true })
  fixture.output.mockReset()
  vi.stubEnv("LEUCO_HOME", home)
  vi.stubGlobal("Bun", { version: "1.4.4", semver: { satisfies: () => true } })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it("starts the daemon with the CLI requestId on its readiness probes", async () => {
  await runCli(["start", "--json"], { requestId: "cli-start" })
  expect(fixture.start).toHaveBeenCalledExactlyOnceWith(
    home,
    expect.anything(),
    expect.objectContaining({ requestId: "cli-start" }),
  )
  expect(fixture.output.mock.calls[0]?.[1]).toMatchObject({ requestId: "cli-start" })
})

it("repairs with the CLI requestId, so events --request finds the restart it schedules", async () => {
  await runCli(["repair", "--json"], { requestId: "cli-repair" })
  expect(fixture.repair).toHaveBeenCalledExactlyOnceWith(
    home,
    expect.objectContaining({ requestId: "cli-repair" }),
  )
  expect(fixture.output.mock.calls[0]?.[1]).toMatchObject({ requestId: "cli-repair" })
})

it("diagnoses with the CLI requestId on the daemon status probe", async () => {
  await runCli(["doctor", "--json"], { requestId: "cli-doctor" })
  expect(fixture.diagnose).toHaveBeenCalledExactlyOnceWith(home, undefined, "cli-doctor")
  expect(fixture.output.mock.calls[0]?.[1]).toMatchObject({ requestId: "cli-doctor" })
})
