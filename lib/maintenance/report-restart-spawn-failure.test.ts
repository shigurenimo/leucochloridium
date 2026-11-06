import { beforeEach, expect, it, vi } from "vitest"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { reportRestartSpawnFailure } from "@/maintenance/report-restart-spawn-failure"

const fixture = vi.hoisted(() => ({ record: vi.fn(), appendLog: vi.fn() }))
vi.mock("@/maintenance/record-restart-spawn-failure", () => ({
  recordRestartSpawnFailure: fixture.record,
}))
vi.mock("@/daemon/append-daemon-log", () => ({ appendDaemonLog: fixture.appendLog }))

const operation: MaintenanceOperation = {
  id: "7b0a3c1e-5f2d-4c8e-9a6b-1d2e3f4a5b6c",
  status: "accepted",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: 41,
  oldPid: 42,
  oldLeaseId: "previous-lease",
  recovery: null,
  newPid: null,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: null },
}
const spawnFailure = Object.assign(new Error("spawn unavailable"), { code: "EMFILE" })
const doubleFailure = new AggregateError(
  [spawnFailure, Object.assign(new Error("journal unavailable"), { code: "EMFILE" })],
  "Restart worker spawn failed and its failure journal could not be saved",
  { cause: spawnFailure },
)

beforeEach(() => {
  fixture.record.mockReset()
  fixture.appendLog.mockReset()
})
it("writes nothing extra when the failure journal was saved", () => {
  const output = new MemoryDiagnosticOutput()
  reportRestartSpawnFailure({ home: "/memory", operation, error: spawnFailure, output })
  expect(fixture.record).toHaveBeenCalledWith("/memory", operation, spawnFailure)
  expect(fixture.appendLog).not.toHaveBeenCalled()
  expect(output.attempts).toEqual([])
})
it("falls back to diagnostic output when daemon.log cannot be opened either", async () => {
  fixture.record.mockImplementationOnce(() => {
    throw doubleFailure
  })
  fixture.appendLog.mockImplementationOnce(() => {
    throw Object.assign(new Error("too many open files"), { code: "EMFILE" })
  })
  const output = new MemoryDiagnosticOutput()
  expect(() =>
    reportRestartSpawnFailure({ home: "/memory", operation, error: spawnFailure, output }),
  ).not.toThrow()
  await vi.waitFor(() => expect(output.attempts).toHaveLength(1))
  expect(output.attempts[0]).toMatch(
    new RegExp(
      `^leuco: \\[error\\] requestId=${operation.id} .*could not be saved; causes: .*EMFILE: spawn unavailable \\| EMFILE: journal unavailable\\n$`,
    ),
  )
})
it("does not reject when the fallback output fails too", async () => {
  fixture.record.mockImplementationOnce(() => {
    throw doubleFailure
  })
  fixture.appendLog.mockImplementationOnce(() => {
    throw new Error("daemon.log unavailable")
  })
  const output = new MemoryDiagnosticOutput()
  output.failure = Object.assign(new Error("stderr closed"), { code: "EPIPE" })
  reportRestartSpawnFailure({ home: "/memory", operation, error: spawnFailure, output })
  await vi.waitFor(() => expect(output.attempts).toHaveLength(1))
})
