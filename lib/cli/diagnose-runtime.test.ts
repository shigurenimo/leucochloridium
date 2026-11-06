import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { diagnoseRuntime } from "@/cli/diagnose-runtime"

const fixture = vi.hoisted(() => ({ control: vi.fn() }))
vi.mock("@/storage/node-leuco-store", async () => {
  const memory = await import("@/storage/memory-leuco-store")
  return {
    NodeLeucoStore: class extends memory.MemoryLeucoStore {
      constructor() {
        super()
      }
    },
  }
})
vi.mock("@/maintenance/node-maintenance-store", async () => {
  const memory = await import("@/maintenance/memory-maintenance-store")
  return {
    NodeMaintenanceStore: class extends memory.MemoryMaintenanceStore {
      constructor() {
        super()
      }
    },
  }
})
vi.mock("@/maintenance/read-maintenance", () => ({ readMaintenance: () => null }))
vi.mock("@/cli/inspect-launch-environment", () => ({
  inspectLaunchEnvironment: () => ({ errors: [], failures: [] }),
}))
vi.mock("@/cli/inspect-diagnostic-history", () => ({
  inspectDiagnosticHistory: () => ({
    eventLogValid: true,
    eventLogPresent: true,
    recentFailures: [],
    errors: [],
    failures: [],
  }),
}))
vi.mock("@/cli/inspect-daemon-control", () => ({ inspectDaemonControl: fixture.control }))
beforeEach(() => {
  fixture.control.mockReset().mockResolvedValue({
    daemon: { running: false },
    controlError: null,
    staleLease: false,
    leaseValid: true,
    processAlive: false,
    errors: [],
    failures: [],
  })
  vi.stubGlobal("Bun", { version: "1.4.4" })
})
afterEach(() => vi.unstubAllGlobals())

it("sends the doctor requestId with its daemon status probe", async () => {
  const signal = new AbortController().signal
  const report = await diagnoseRuntime("/memory", signal, "doctor-request")
  expect(report.healthy).toBe(true)
  expect(fixture.control).toHaveBeenCalledExactlyOnceWith("/memory", {
    signal,
    requestId: "doctor-request",
    maintenance: null,
  })
})
