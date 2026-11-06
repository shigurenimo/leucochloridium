import { afterEach, expect, it, vi } from "vitest"
import { stopDaemon } from "@/daemon/stop-daemon"
import { requestDaemon } from "@/daemon/request-daemon"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"

const fixture = vi.hoisted(() => ({ hasLease: { value: true }, exited: new Set<number>() }))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: () =>
    fixture.hasLease.value ? { pid: 42, token: "synthetic-control-token" } : null,
  isProcessAlive: (pid: number) => !fixture.exited.has(pid),
}))
vi.mock("@/daemon/request-daemon", () => ({
  requestDaemon: vi.fn(async () => ({ stopped: true, processWillExit: true })),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  fixture.hasLease.value = true
  fixture.exited.clear()
})
const recorded: MaintenanceOperation = {
  id: "bcbad0ce-c551-4f38-902a-fd8e41c7db2e",
  status: "ready",
  requestedAt: 1,
  updatedAt: 2,
  workerPid: null,
  oldPid: 41,
  oldLeaseId: "previous-lease",
  recovery: null,
  newPid: 42,
  oldPidExited: true,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: null },
}

it("confirms the stopped daemon's recorded PID only after its exit was observed", async () => {
  const maintenance = new MemoryMaintenanceStore()
  maintenance.writeOperation(recorded)
  vi.mocked(requestDaemon).mockImplementationOnce(async () => {
    fixture.exited.add(42)
    return { stopped: true, processWillExit: true }
  })
  await expect(stopDaemon({ home: "/memory", requestId: "stop", maintenance })).resolves.toEqual({
    stopped: true,
  })
  expect(maintenance.readOperation()).toMatchObject({ newPid: 42, newPidExited: true })
  fixture.exited.clear()
  fixture.hasLease.value = false
  await expect(stopDaemon({ home: "/memory", requestId: "reused", maintenance })).resolves.toEqual({
    running: false,
  })
})
it("does not report stopped when the maintenance journal is unreadable", async () => {
  fixture.hasLease.value = false
  const maintenance = new MemoryMaintenanceStore()
  vi.spyOn(maintenance, "readOperation").mockImplementation(() => {
    throw new Error("journal is not JSON")
  })
  await expect(
    stopDaemon({ home: "/memory", requestId: "unreadable", maintenance }),
  ).rejects.toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "maintenance-journal", executionStarted: false },
  })
  expect(requestDaemon).not.toHaveBeenCalled()
})

it("bounds process-exit observation when the wall clock moves backwards", async () => {
  vi.useFakeTimers()
  const observed: { failure: unknown } = { failure: null }
  const pending = stopDaemon({
    home: "/memory",
    requestId: "stop-probe",
    maintenance: new MemoryMaintenanceStore(),
  }).catch((error: unknown) => {
    observed.failure = error
  })
  await vi.advanceTimersByTimeAsync(5)
  vi.setSystemTime(Date.now() - 60000)
  await vi.advanceTimersByTimeAsync(15000)
  expect(observed.failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "process-exit", pid: 42, resourcesStopped: true, cancelled: false },
    cause: expect.objectContaining({ message: "Process exit was not observed within 15000ms" }),
  })
  await pending
  expect(requestDaemon).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("ends process-exit observation promptly when the caller cancels after shutdown acknowledgement", async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const observed: { failure: unknown } = { failure: null }
  const pending = stopDaemon({
    home: "/memory",
    requestId: "cancel-stop",
    signal: controller.signal,
    maintenance: new MemoryMaintenanceStore(),
  }).catch((error: unknown) => {
    observed.failure = error
  })
  try {
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error("caller stopped observing"))
    await vi.advanceTimersByTimeAsync(1)
    expect(observed.failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: { phase: "process-exit", pid: 42, resourcesStopped: true, cancelled: true },
      cause: expect.objectContaining({ message: "caller stopped observing" }),
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(requestDaemon).toHaveBeenCalledOnce()
  } finally {
    await vi.advanceTimersByTimeAsync(15000)
    await pending
  }
})
