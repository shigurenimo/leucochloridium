import { beforeEach, expect, it, vi } from "vitest"
import { startDaemon } from "@/daemon/start-daemon"
import { errorDetails } from "@/error-details"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import { waitForDaemonReady } from "@/daemon/wait-for-daemon-ready"

const fixture = vi.hoisted(() => {
  const maintenance: { store: MaintenanceStore | null } = { store: null }
  return {
    maintenance,
    spawn: vi.fn(),
    ensureHome: vi.fn(),
    lease: vi.fn(),
    alive: vi.fn(),
    close: vi.fn(),
    child: { pid: 42, on: vi.fn(), unref: vi.fn() },
  }
})
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }))
vi.mock("node:fs", () => ({ closeSync: fixture.close }))
vi.mock("@/daemon/open-daemon-log", () => ({ openDaemonLog: () => 7 }))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: fixture.lease,
  isProcessAlive: fixture.alive,
}))
vi.mock("@/daemon/wait-for-daemon-ready", () => ({
  waitForDaemonReady: vi.fn(async () => ({ running: true, ready: true, pid: 42 })),
}))
vi.mock("@/maintenance/node-maintenance-store", () => ({
  NodeMaintenanceStore: class {
    readOperation() {
      return fixture.maintenance.store?.readOperation() ?? null
    }
  },
}))
vi.mock("@/storage/node-leuco-store", () => ({
  NodeLeucoStore: class {
    ensureHome = fixture.ensureHome
  },
}))
beforeEach(() => {
  fixture.maintenance.store = new MemoryMaintenanceStore()
  fixture.ensureHome.mockReset()
  fixture.lease.mockReset().mockReturnValue(null)
  fixture.alive.mockReset().mockReturnValue(false)
  fixture.spawn.mockReset().mockReturnValue(fixture.child)
  fixture.close.mockReset()
  fixture.child.on.mockReset().mockReturnValue(fixture.child)
  fixture.child.unref.mockReset()
})
const parsed = { words: ["start"], flags: {} }
it("closes the log descriptor when spawn throws synchronously", async () => {
  const failure = Object.assign(new Error("spawn unavailable"), { code: "EAGAIN" })
  fixture.spawn.mockImplementationOnce(() => {
    throw failure
  })
  await expect(startDaemon("/memory", parsed)).rejects.toBe(failure)
  expect(fixture.close).toHaveBeenCalledExactlyOnceWith(7)
})
it("keeps spawn and descriptor-close failures together", async () => {
  fixture.spawn.mockImplementationOnce(() => {
    throw Object.assign(new Error("spawn unavailable"), { code: "EAGAIN" })
  })
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EIO" })
  })
  const failure = await startDaemon("/memory", parsed).catch((error: unknown) => error)
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EAGAIN", "EIO"]),
  )
})
it("retains the spawned PID and observes child errors before failed log cleanup", async () => {
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EIO" })
  })
  const failure = await startDaemon("/memory", parsed).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "launch-cleanup", pid: 42 },
  })
  expect(fixture.child.on.mock.calls.map((call) => call[0])).toEqual(
    expect.arrayContaining(["error", "exit"]),
  )
  expect(fixture.child.unref).toHaveBeenCalledOnce()
  expect(fixture.spawn).toHaveBeenCalledOnce()
})

it("prepares home only after confirming no existing daemon owns it", async () => {
  await startDaemon("/memory", parsed)
  expect(fixture.ensureHome).toHaveBeenCalledOnce()
  expect(fixture.ensureHome.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.spawn.mock.invocationCallOrder[0]!,
  )
})
it("observes readiness with the CLI requestId", async () => {
  const requestId = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
  await startDaemon("/memory", parsed, { requestId })
  expect(waitForDaemonReady).toHaveBeenLastCalledWith(
    expect.objectContaining({ pid: 42, requestId }),
  )
})
it("rejects an existing daemon without changing home permissions or spawning", async () => {
  fixture.lease.mockReturnValue({ pid: 42, token: "synthetic-owner" })
  fixture.alive.mockReturnValue(true)
  await expect(startDaemon("/memory", parsed)).rejects.toMatchObject({ code: "STATE_CONFLICT" })
  expect(fixture.ensureHome).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})
it("refuses a live unverified recorded daemon with the same identity error as status and stop", async () => {
  fixture.maintenance.store?.writeOperation({
    id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
    status: "uncertain",
    requestedAt: 1,
    updatedAt: 2,
    workerPid: null,
    oldPid: 77,
    oldLeaseId: null,
    recovery: null,
    newPid: null,
    error: "ownership missing",
    launch: { workingDirectory: "/memory", codexHome: null },
  })
  fixture.alive.mockImplementation((pid: number) => pid === 77)
  await expect(startDaemon("/memory", parsed)).rejects.toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "identity", pid: 77, executionStarted: false },
  })
  expect(fixture.ensureHome).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})
it("refuses an unreadable maintenance journal before spawning", async () => {
  vi.spyOn(fixture.maintenance.store!, "readOperation").mockImplementation(() => {
    throw new Error("journal is not JSON")
  })
  await expect(startDaemon("/memory", parsed)).rejects.toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "maintenance-journal", executionStarted: false },
  })
  expect(fixture.spawn).not.toHaveBeenCalled()
})
