import { expect, it } from "vitest"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import { readMaintenanceOperation } from "@/maintenance/read-maintenance-operation"
import { errorDetails } from "@/error-details"

class UnreadableMaintenanceStore extends MemoryMaintenanceStore {
  override readOperation(): never {
    throw Object.assign(new Error("journal is not JSON"), { code: "EJOURNAL" })
  }
}

it("returns the journal or null when it is readable", () => {
  expect(readMaintenanceOperation(new MemoryMaintenanceStore())).toBeNull()
})
it("treats an unreadable journal as unverifiable recorded ownership", () => {
  const failure = (() => {
    try {
      return readMaintenanceOperation(new UnreadableMaintenanceStore())
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "maintenance-journal", executionStarted: false },
  })
  expect(errorDetails(failure).map((cause) => cause.code)).toContain("EJOURNAL")
})
