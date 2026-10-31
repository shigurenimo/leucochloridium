import { expect, it } from "vitest"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { operationSchema } from "@/maintenance/maintenance-schema"

const operation = operationSchema.parse({
  id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
  status: "uncertain",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: null,
  oldPid: 42,
  oldLeaseId: "previous-lease",
  recovery: null,
  newPid: 43,
  error: "ownership missing",
  launch: { workingDirectory: "/memory", codexHome: null },
})

it.each([42, 43])("refuses a live recorded daemon PID %i when ownership is missing", (pid) => {
  try {
    assertRecordedDaemonsStopped(operation, (candidate) => candidate === pid)
    throw new Error("Expected ownership refusal")
  } catch (failure) {
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: { phase: "identity", pid, operationId: operation.id, executionStarted: false },
    })
  }
})
it("allows absent or confirmed stopped maintenance processes", () => {
  expect(() => assertRecordedDaemonsStopped(null, () => true)).not.toThrow()
  expect(() => assertRecordedDaemonsStopped(operation, () => false)).not.toThrow()
})
it("permits the acquiring process itself but still checks every other recorded PID", () => {
  expect(() => assertRecordedDaemonsStopped(operation, (pid) => pid === 42, 42)).not.toThrow()
  expect(() => assertRecordedDaemonsStopped(operation, () => true, 42)).toThrow("still alive")
})
