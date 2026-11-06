import { expect, it } from "vitest"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { recordReplacementExit } from "@/maintenance/record-replacement-exit"

const operation: MaintenanceOperation = {
  id: "4f0f1bd2-3d0c-4a43-9b8d-0f3f1e0b6c11",
  status: "starting",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: 41,
  oldPid: 42,
  oldLeaseId: "previous-lease",
  recovery: null,
  oldPidExited: true,
  newPid: 43,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: "/memory/codex", cwd: "/memory/missing" },
}

it("confirms a replacement that exited before taking ownership", () => {
  const store = new MemoryMaintenanceStore()
  store.writeOperation(operation)
  expect(recordReplacementExit(store, { pid: 43, exited: true })).toBe(true)
  expect(store.readOperation()).toMatchObject({ newPid: 43, newPidExited: true })
})
it("does not confirm a replacement whose exit was not observed", () => {
  const store = new MemoryMaintenanceStore()
  store.writeOperation(operation)
  expect(recordReplacementExit(store, { pid: 43, exited: false })).toBe(false)
  expect(recordReplacementExit(store, { pid: null, exited: true })).toBe(false)
  expect(recordReplacementExit(store, null)).toBe(false)
  expect(store.readOperation()?.newPidExited).toBeUndefined()
})
it("does not confirm a different replacement recorded in the journal", () => {
  const store = new MemoryMaintenanceStore()
  store.writeOperation({ ...operation, newPid: 44 })
  expect(recordReplacementExit(store, { pid: 43, exited: true })).toBe(false)
  expect(store.readOperation()?.newPidExited).toBeUndefined()
})
