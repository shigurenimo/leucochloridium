import { expect, it, vi } from "vitest"
import { releaseDaemonOwnership } from "@/daemon/release-daemon-ownership"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"

const lease = { pid: 43, token: "replacement-owner" }
const operation: MaintenanceOperation = {
  id: "9b7c2f1e-6a1d-4f7e-8c3b-2d5e4f6a7b8c",
  status: "ready",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: null,
  oldPid: 42,
  oldLeaseId: "previous-lease",
  recovery: null,
  oldPidExited: true,
  newPid: 43,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: null },
}

it("records its own exit after a complete shutdown releases ownership", () => {
  const maintenance = new MemoryMaintenanceStore()
  maintenance.writeOperation(operation)
  const release = vi.fn(() => true)
  expect(releaseDaemonOwnership({ lease, isCleanupComplete: true, release, maintenance })).toBe(
    "released",
  )
  expect(release).toHaveBeenCalledWith(lease)
  expect(maintenance.readOperation()).toMatchObject({ newPid: 43, newPidExited: true })
})
it("keeps ownership and the recorded-PID guard when cleanup failed", () => {
  const maintenance = new MemoryMaintenanceStore()
  maintenance.writeOperation(operation)
  const release = vi.fn(() => true)
  expect(releaseDaemonOwnership({ lease, isCleanupComplete: false, release, maintenance })).toBe(
    "retained",
  )
  expect(release).not.toHaveBeenCalled()
  expect(maintenance.readOperation()?.newPidExited).toBeUndefined()
})
it("does not record an exit when the lease was no longer its own", () => {
  const maintenance = new MemoryMaintenanceStore()
  maintenance.writeOperation(operation)
  expect(
    releaseDaemonOwnership({ lease, isCleanupComplete: true, release: () => false, maintenance }),
  ).toBe("not-owned")
  expect(maintenance.readOperation()?.newPidExited).toBeUndefined()
})
it("propagates a release failure without recording an exit", () => {
  const maintenance = new MemoryMaintenanceStore()
  maintenance.writeOperation(operation)
  const release = () => {
    throw Object.assign(new Error("lifecycle lock unavailable"), { code: "EACCES" })
  }
  expect(() =>
    releaseDaemonOwnership({ lease, isCleanupComplete: true, release, maintenance }),
  ).toThrow("lifecycle lock unavailable")
  expect(maintenance.readOperation()?.newPidExited).toBeUndefined()
})
