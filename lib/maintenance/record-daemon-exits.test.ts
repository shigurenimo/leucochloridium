import { expect, it, vi } from "vitest"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { recordDaemonExits } from "@/maintenance/record-daemon-exits"

const operation: MaintenanceOperation = {
  id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
  status: "ready",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: null,
  oldPid: 42,
  oldLeaseId: "previous-lease",
  recovery: null,
  newPid: 43,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: null },
}

it("confirms only the recorded PIDs that were observed to exit", () => {
  const store = new MemoryMaintenanceStore()
  store.writeOperation(operation)
  expect(recordDaemonExits(store, (pid) => pid === 42)).toBe(true)
  expect(store.readOperation()).toMatchObject({ oldPidExited: true })
  expect(store.readOperation()?.newPidExited).toBeUndefined()
  expect(recordDaemonExits(store, () => true)).toBe(true)
  expect(store.readOperation()).toMatchObject({ oldPidExited: true, newPidExited: true })
})
it("does not rewrite the journal when nothing new was observed", () => {
  const store = new MemoryMaintenanceStore()
  expect(recordDaemonExits(store, () => true)).toBe(false)
  store.writeOperation({ ...operation, oldPidExited: true })
  const update = vi.spyOn(store, "updateOperation")
  expect(recordDaemonExits(store, (pid) => pid === 42)).toBe(false)
  expect(recordDaemonExits(store, () => false)).toBe(false)
  expect(update).not.toHaveBeenCalled()
})
it("does not confirm a role whose PID changed before the locked update", () => {
  const store = new MemoryMaintenanceStore()
  store.writeOperation({ ...operation, newPid: null })
  vi.spyOn(store, "readOperation").mockReturnValueOnce(operation)
  expect(recordDaemonExits(store, (pid) => pid === 43)).toBe(true)
  expect(store.readOperation()?.newPidExited).toBeUndefined()
})
it("keeps the recorded-PID guard closed instead of failing when the confirmation cannot be saved", () => {
  const store = new MemoryMaintenanceStore()
  store.writeOperation(operation)
  vi.spyOn(store, "updateOperation").mockImplementationOnce(() => {
    throw Object.assign(new Error("journal write failed"), { code: "ENOSPC" })
  })
  expect(recordDaemonExits(store, () => true)).toBe(false)
  expect(store.readOperation()?.oldPidExited).toBeUndefined()
})
