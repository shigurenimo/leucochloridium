import { beforeEach, expect, it, vi } from "vitest"
import { inspectDaemonControl } from "@/cli/inspect-daemon-control"
import { operationSchema } from "@/maintenance/maintenance-schema"

const fixture = vi.hoisted(() => ({ lease: vi.fn(), request: vi.fn() }))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: fixture.lease,
  isProcessAlive: (pid: number) => pid === 42,
}))
vi.mock("@/daemon/request-daemon", () => ({ requestDaemon: fixture.request }))
beforeEach(() => {
  fixture.lease.mockReset().mockReturnValue(null)
  fixture.request.mockReset()
})

it.each([
  { oldPid: 42, newPid: null, leasePid: null },
  { oldPid: null, newPid: 42, leasePid: null },
  { oldPid: 42, newPid: null, leasePid: 77 },
  { oldPid: null, newPid: 42, leasePid: 77 },
])(
  "preserves unverified live PID evidence with $oldPid/$newPid and lease $leasePid",
  async (probe) => {
    fixture.lease.mockReturnValue(
      probe.leasePid === null ? null : { pid: probe.leasePid, token: "synthetic" },
    )
    const operation = operationSchema.parse({
      id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
      status: "uncertain",
      requestedAt: 1,
      updatedAt: 2,
      workerPid: null,
      oldPid: probe.oldPid,
      oldLeaseId: null,
      recovery: null,
      newPid: probe.newPid,
      error: "ownership missing",
      launch: { workingDirectory: "/memory", codexHome: null },
    })
    const result = await inspectDaemonControl("/memory", {
      maintenance: { ...operation, workerAlive: false },
    })
    expect(result.daemon).toMatchObject({
      running: null,
      ready: false,
      pid: 42,
      ownership: "unknown",
    })
    expect(result.processAlive).toBe(true)
    expect(result.staleLease).toBe(false)
    expect(result.failures).toEqual(
      expect.arrayContaining([expect.objectContaining({ phase: "identity" })]),
    )
    expect(result.errors.join(" ")).not.toContain("Run leuco start")
    expect(fixture.request).not.toHaveBeenCalled()
  },
)
it("does not treat a reused PID as a recorded daemon after its exit was confirmed", async () => {
  const operation = operationSchema.parse({
    id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
    status: "ready",
    requestedAt: 1,
    updatedAt: 2,
    workerPid: null,
    oldPid: 41,
    oldLeaseId: null,
    recovery: null,
    newPid: 42,
    oldPidExited: true,
    newPidExited: true,
    error: null,
    launch: { workingDirectory: "/memory", codexHome: null },
  })
  const result = await inspectDaemonControl("/memory", {
    maintenance: { ...operation, workerAlive: false },
  })
  expect(result.daemon).toEqual({ running: false })
  expect(result.processAlive).toBe(false)
  expect(result.failures).toEqual([])
})
it("does not offer stale-lease repair while the maintenance journal is unreadable", async () => {
  fixture.lease.mockReturnValue({ pid: 77, token: "synthetic" })
  const result = await inspectDaemonControl("/memory", {
    maintenance: { status: "unreadable", causes: [], error: "Maintenance journal is invalid" },
  })
  expect(result.daemon).toMatchObject({ running: null, ownership: "unknown" })
  expect(result.staleLease).toBe(false)
  expect(result.errors.join(" ")).not.toContain("Run leuco start")
})
it("sends the CLI requestId with the authenticated status probe", async () => {
  const lease = { pid: 42, token: "synthetic" }
  fixture.lease.mockReturnValue(lease)
  fixture.request.mockResolvedValue({ running: true, ready: true, pid: 42 })
  const requestId = "9a4c2f3e-5b61-4d7a-8e90-1f2a3b4c5d6e"
  await inspectDaemonControl("/memory", { requestId })
  expect(fixture.request).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/status", requestId, expectedLease: lease }),
  )
})
