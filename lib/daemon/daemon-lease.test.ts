import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { DaemonLease } from "@/daemon/daemon-lease"
import { acquireDaemonLease, readDaemonLease, releaseDaemonLease } from "@/daemon/daemon-lease"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"

const fixture = vi.hoisted(() => {
  const state: { lease: DaemonLease | null; maintenance: MaintenanceStore | null } = {
    lease: null,
    maintenance: null,
  }
  return { state, remove: vi.fn(), publish: vi.fn() }
})
vi.mock("node:fs", () => ({
  lstatSync: () => (fixture.state.lease === null ? undefined : {}),
  rmSync: fixture.remove,
}))
vi.mock("@/maintenance/node-maintenance-store", () => ({
  NodeMaintenanceStore: class {
    readOperation() {
      return fixture.state.maintenance?.readOperation() ?? null
    }
    updateOperation(
      id: string,
      transform: (operation: MaintenanceOperation) => MaintenanceOperation,
    ) {
      return fixture.state.maintenance?.updateOperation(id, transform) ?? null
    }
  },
}))
vi.mock("node:crypto", () => ({ randomUUID: () => "new-owner-token" }))
vi.mock("@/fs/read-regular-json", () => ({
  readRegularJson: () => fixture.state.lease,
}))
vi.mock("@/fs/atomic-write-json", () => ({ atomicWriteJson: fixture.publish }))
vi.mock("@/fs/with-file-lock", () => ({
  withFileLock: (_props: unknown, operation: () => unknown) => operation(),
}))
beforeEach(() => {
  fixture.state.lease = null
  fixture.state.maintenance = new MemoryMaintenanceStore()
  fixture.remove.mockReset()
  fixture.publish.mockReset().mockImplementation((props: { data: DaemonLease }) => {
    fixture.state.lease = props.data
  })
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("confirmed dead"), { code: "ESRCH" })
  })
})
afterEach(() => vi.restoreAllMocks())

it("does not publish a live owner when control-path preparation fails", () => {
  fixture.remove.mockImplementationOnce(() => {
    throw Object.assign(new Error("control path is a directory"), { code: "EISDIR" })
  })
  expect(() => acquireDaemonLease("/memory")).toThrow("control path")
  expect(readDaemonLease("/memory")).toBeNull()
  expect(fixture.publish).not.toHaveBeenCalled()
})
it("retains prior ownership metadata if stale-control preparation fails", () => {
  const previous = { pid: 42, token: "previous-owner" }
  fixture.state.lease = previous
  fixture.remove.mockImplementationOnce(() => {
    throw new Error("preparation failed")
  })
  expect(() => acquireDaemonLease("/memory")).toThrow("preparation failed")
  expect(readDaemonLease("/memory")).toEqual(previous)
  expect(fixture.publish).not.toHaveBeenCalled()
})
it("never prepares or publishes over a live owner", () => {
  const previous = { pid: 42, token: "live-owner" }
  fixture.state.lease = previous
  vi.mocked(process.kill).mockReturnValue(true)
  expect(() => acquireDaemonLease("/memory")).toThrow("already running")
  expect(fixture.remove).not.toHaveBeenCalled()
  expect(fixture.publish).not.toHaveBeenCalled()
  expect(readDaemonLease("/memory")).toEqual(previous)
})
it("publishes only after stale-control preparation succeeds", () => {
  const previous = { pid: 42, token: "previous-owner" }
  fixture.state.lease = previous
  fixture.remove.mockImplementationOnce(() => {
    expect(readDaemonLease("/memory")).toEqual(previous)
  })
  const accepted = acquireDaemonLease("/memory")
  expect(accepted).toEqual({ pid: process.pid, token: "new-owner-token" })
  expect(readDaemonLease("/memory")).toEqual(accepted)
  expect(fixture.publish).toHaveBeenCalledOnce()
})
it("retains previous ownership when the atomic publication fails", () => {
  const previous = { pid: 42, token: "previous-owner" }
  fixture.state.lease = previous
  fixture.publish.mockImplementationOnce(() => {
    throw new Error("publication failed")
  })
  expect(() => acquireDaemonLease("/memory")).toThrow("publication failed")
  expect(readDaemonLease("/memory")).toEqual(previous)
})

it.each([{ pid: 43, token: "owned-token" }, { pid: 42, token: "different-token" }, null])(
  "does not remove a lease or control path after ownership changed (%j)",
  (current) => {
    fixture.state.lease = current
    expect(releaseDaemonLease("/memory", { pid: 42, token: "owned-token" })).toBe(false)
    expect(fixture.remove).not.toHaveBeenCalled()
    expect(readDaemonLease("/memory")).toEqual(current)
  },
)
it("releases both paths only for the exact current owner", () => {
  const owner = { pid: 42, token: "owned-token" }
  fixture.state.lease = owner
  expect(releaseDaemonLease("/memory", owner)).toBe(true)
  expect(fixture.remove.mock.calls).toEqual([
    ["/memory/control.sock", { force: true }],
    ["/memory/daemon.json", { force: true }],
  ])
})

const recorded: MaintenanceOperation = {
  id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
  status: "ready",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: null,
  oldPid: 42,
  oldLeaseId: "previous-lease",
  recovery: null,
  newPid: process.pid,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: null },
}
it("confirms exited recorded daemons other than itself after acquiring ownership", () => {
  fixture.state.maintenance?.writeOperation(recorded)
  acquireDaemonLease("/memory")
  expect(fixture.state.maintenance?.readOperation()).toMatchObject({ oldPidExited: true })
  expect(fixture.state.maintenance?.readOperation()?.newPidExited).toBeUndefined()
})
it("accepts a reused PID number only after its recorded daemon exit was confirmed", () => {
  vi.mocked(process.kill).mockReturnValue(true)
  fixture.state.maintenance?.writeOperation({ ...recorded, newPid: null })
  expect(() => acquireDaemonLease("/memory")).toThrow(
    expect.objectContaining({ details: expect.objectContaining({ phase: "identity", pid: 42 }) }),
  )
  fixture.state.maintenance?.writeOperation({ ...recorded, newPid: null, oldPidExited: true })
  expect(acquireDaemonLease("/memory")).toEqual({ pid: process.pid, token: "new-owner-token" })
})
it("does not publish ownership when the maintenance journal is unreadable", () => {
  vi.spyOn(fixture.state.maintenance!, "readOperation").mockImplementation(() => {
    throw new Error("journal is not JSON")
  })
  expect(() => acquireDaemonLease("/memory")).toThrow(
    expect.objectContaining({
      code: "STATE_UNCERTAIN",
      details: expect.objectContaining({ phase: "maintenance-journal", executionStarted: false }),
    }),
  )
  expect(fixture.publish).not.toHaveBeenCalled()
})
