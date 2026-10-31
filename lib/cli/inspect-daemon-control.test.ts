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
    const result = await inspectDaemonControl("/memory", undefined, {
      ...operation,
      workerAlive: false,
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
