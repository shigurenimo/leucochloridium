import { beforeEach, expect, it, vi } from "vitest"
import { repairRuntime } from "@/maintenance/repair-runtime"

const fixture = vi.hoisted(() => ({ request: vi.fn(), history: vi.fn(), codexRunning: true }))
vi.mock("@/cli/inspect-diagnostic-history", () => ({ inspectDiagnosticHistory: fixture.history }))
vi.mock("@/storage/node-leuco-store", () => ({
  NodeLeucoStore: class {
    loadSettings() {
      return {}
    }
    loadState() {
      return {}
    }
    ensureHome() {}
  },
}))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: () => ({ pid: 42, token: "synthetic-owner" }),
  isProcessAlive: () => true,
}))
vi.mock("@/daemon/request-daemon", () => ({ requestDaemon: fixture.request }))
vi.mock("@/fs/with-file-lock", () => ({
  withFileLock: (_: unknown, operation: () => unknown) => operation(),
}))
vi.mock("node:fs", () => ({ existsSync: () => false }))
beforeEach(() => {
  fixture.codexRunning = true
  fixture.history.mockReset().mockReturnValue({
    eventLogValid: false,
    eventLogPresent: false,
    errors: ["Event database is missing"],
  })
  fixture.request
    .mockReset()
    .mockImplementation(async (props: { path: string }) =>
      props.path === "/status"
        ? { running: true, ready: true, runtime: { codexRunning: fixture.codexRunning } }
        : { id: "recovery", status: "accepted" },
    )
})
it.each([true, false])(
  "does not report recovery or restart with unverified history (Codex running: %s)",
  async (running) => {
    fixture.codexRunning = running
    const repair = await repairRuntime("/memory", { resetState: false })
    expect(repair).toMatchObject({
      repaired: false,
      restart: null,
      issues: expect.arrayContaining(["Event database is missing"]),
    })
    expect(repair.note).toContain("leuco doctor")
    expect(fixture.request.mock.calls.map((call) => call[0].path)).toEqual(["/status"])
  },
)
it("keeps transport recovery available after history is verified", async () => {
  fixture.codexRunning = false
  fixture.history.mockReturnValue({ eventLogValid: true, errors: [] })
  const repair = await repairRuntime("/memory", { resetState: false })
  expect(repair).toMatchObject({ repaired: true, restart: { id: "recovery", status: "accepted" } })
  expect(fixture.request.mock.calls.map((call) => call[0].path)).toEqual(["/status", "/restart"])
})

it("keeps independent transport recovery available with an existing unreadable database", async () => {
  fixture.codexRunning = false
  fixture.history.mockReturnValue({
    eventLogValid: false,
    eventLogPresent: true,
    errors: ["Event database is unreadable"],
  })
  const repair = await repairRuntime("/memory", { resetState: false })
  expect(repair).toMatchObject({
    repaired: true,
    restart: { id: "recovery" },
    issues: ["Event database is unreadable"],
  })
})
