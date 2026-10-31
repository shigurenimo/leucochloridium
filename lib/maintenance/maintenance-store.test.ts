import { describe, expect, it } from "vitest"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import { operationSchema } from "@/maintenance/maintenance-schema"

const operation = (id: string) =>
  operationSchema.parse({
    id,
    status: "accepted",
    requestedAt: 1,
    updatedAt: 1,
    workerPid: null,
    oldPid: null,
    oldLeaseId: null,
    recovery: null,
    newPid: null,
    error: null,
    launch: { workingDirectory: "/work", codexHome: null },
  })
describe("maintenance journal ownership", () => {
  it.each(["workingDirectory", "cwd", "soul"])(
    "preserves launch configuration when %s is not absolute",
    (field) => {
      const store = new MemoryMaintenanceStore()
      const launch = { workingDirectory: "/work", codexHome: null, cwd: "/work", soul: null }
      store.writeLaunch(launch)
      for (const value of ["", "relative/path"]) {
        expect(() => store.writeLaunch({ ...launch, [field]: value })).toThrow()
        expect(store.readLaunch()).toEqual(launch)
      }
    },
  )
  it("refuses an old worker update after a newer operation replaces it", () => {
    const store = new MemoryMaintenanceStore()
    const first = operation("6e6d9bcc-a07c-4c72-93f0-7eb651f9711d")
    const next = operation("7e6d9bcc-a07c-4c72-93f0-7eb651f9711d")
    store.writeOperation(first)
    store.writeOperation(next)
    expect(
      store.updateOperation(first.id, (current) => ({ ...current, status: "ready" })),
    ).toBeNull()
    expect(store.readOperation()?.id).toBe(next.id)
    store.updateOperation(next.id, (current) => ({ ...current, status: "starting" }))
    store.updateOperation(next.id, (current) => ({ ...current, eventLogError: "disk locked" }))
    expect(store.readOperation()).toMatchObject({
      id: next.id,
      status: "starting",
      eventLogError: "disk locked",
    })
  })
})
