import { beforeEach, expect, it, vi } from "vitest"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { errorDetails } from "@/error-details"
const fixture = vi.hoisted(() => {
  const journal: { operation: unknown } = { operation: null }
  return {
    journal,
    readLease: vi.fn(),
    alive: vi.fn(),
    record: vi.fn(),
    spawn: vi.fn(),
    child: { pid: 42, on: vi.fn(), unref: vi.fn() },
  }
})
vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>()
  return { ...path, resolve: () => "/memory/restart-worker.ts" }
})
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }))
vi.mock("@/storage/node-leuco-store", () => ({
  NodeLeucoStore: class {
    ensureHome() {}
  },
}))
vi.mock("@/maintenance/node-maintenance-store", () => ({
  NodeMaintenanceStore: class {
    readOperation() {
      return fixture.journal.operation
    }
    readLaunch() {
      return null
    }
  },
}))
vi.mock("@/maintenance/record-maintenance-operation", () => ({
  recordMaintenanceOperation: fixture.record,
}))
vi.mock("@/fs/with-file-lock", () => ({
  withFileLock: (_props: unknown, operation: () => unknown) => operation(),
}))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: fixture.readLease,
  isProcessAlive: fixture.alive,
}))
beforeEach(() => {
  fixture.journal.operation = null
  fixture.readLease.mockReset().mockReturnValue(null)
  fixture.alive.mockReset().mockReturnValue(false)
  fixture.spawn.mockReset().mockReturnValue(fixture.child)
  fixture.child.on.mockReset().mockReturnValue(fixture.child)
  fixture.child.unref.mockReset()
  fixture.record.mockReset().mockImplementation((_home: string, operation: unknown) => {
    fixture.journal.operation = operation
    return true
  })
})
it("records synchronous worker spawn failure as terminal with its OS cause", () => {
  const failure = Object.assign(new Error("spawn unavailable"), { code: "EAGAIN" })
  fixture.spawn.mockImplementationOnce(() => {
    throw failure
  })
  expect(() => scheduleRestart("/memory")).toThrow("spawn unavailable")
  expect(fixture.journal.operation).toMatchObject({
    status: "failed",
    causes: expect.arrayContaining([expect.objectContaining({ code: "EAGAIN" })]),
  })
})
it("keeps the actual asynchronous spawn error in the journal", () => {
  scheduleRestart("/memory")
  const listener = fixture.child.on.mock.calls.find((call) => call[0] === "error")?.[1]
  expect(typeof listener).toBe("function")
  listener(Object.assign(new Error("permission denied xoxb-synthetic-secret"), { code: "EACCES" }))
  expect(fixture.journal.operation).toMatchObject({
    status: "failed",
    causes: expect.arrayContaining([expect.objectContaining({ code: "EACCES" })]),
  })
  expect(JSON.stringify(fixture.journal.operation)).not.toContain("xoxb-synthetic-secret")
})
it("observes and detaches a worker before publication can fail", () => {
  fixture.record
    .mockImplementationOnce((_home: string, operation: unknown) => {
      fixture.journal.operation = operation
      return true
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("journal failed"), { code: "EDQUOT" })
    })
  const failure = (() => {
    try {
      return scheduleRestart("/memory")
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "worker-publication", workerPid: 42 },
  })
  expect(fixture.child.on.mock.calls.map((call) => call[0])).toContain("error")
  expect(fixture.child.unref).toHaveBeenCalledOnce()
})
it("keeps spawn and failure-journal errors together", () => {
  fixture.spawn.mockImplementationOnce(() => {
    throw Object.assign(new Error("spawn unavailable"), { code: "EAGAIN" })
  })
  fixture.record
    .mockImplementationOnce((_home: string, operation: unknown) => {
      fixture.journal.operation = operation
      return true
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("journal failed"), { code: "EDQUOT" })
    })
  const failure = (() => {
    try {
      return scheduleRestart("/memory")
    } catch (error) {
      return error
    }
  })()
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EAGAIN", "EDQUOT"]),
  )
})

it("does not report a worker as accepted after journal ownership changes", () => {
  fixture.record.mockReturnValueOnce(true).mockReturnValueOnce(false)
  const failure = (() => {
    try {
      return scheduleRestart("/memory")
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "worker-publication", workerPid: 42 },
  })
  expect(fixture.spawn).toHaveBeenCalledOnce()
})

it.each([{ pid: 43, token: "expected-token" }, { pid: 42, token: "new-token" }, null])(
  "rejects stale restart ownership before journaling or spawning (%j)",
  (current) => {
    fixture.readLease.mockReturnValue(current)
    const failure = (() => {
      try {
        return scheduleRestart(
          "/memory",
          {},
          { automatic: true, expectedLease: { pid: 42, token: "expected-token" } },
        )
      } catch (error) {
        return error
      }
    })()
    expect(failure).toMatchObject({
      code: "STATE_CONFLICT",
      details: { phase: "identity", executionStarted: false, expectedPid: 42 },
    })
    expect(fixture.record).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  },
)
it("does not attach a stale restart requester to another owner's active worker", () => {
  fixture.readLease.mockReturnValue({ pid: 43, token: "new-token" })
  fixture.alive.mockReturnValue(true)
  fixture.journal.operation = { id: "other-operation", workerPid: 44, status: "accepted" }
  expect(() =>
    scheduleRestart("/memory", {}, { expectedLease: { pid: 42, token: "expected-token" } }),
  ).toThrow("ownership changed")
  expect(fixture.record).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})
it("does not schedule an offline request if an owner appeared after its snapshot", () => {
  fixture.readLease.mockReturnValue({ pid: 43, token: "new-token" })
  expect(() => scheduleRestart("/memory", {}, { expectedLease: null })).toThrow("ownership changed")
  expect(fixture.record).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})
it("accepts a restart when its ownership snapshot still matches", () => {
  const current = { pid: 42, token: "expected-token" }
  fixture.readLease.mockReturnValue(current)
  expect(scheduleRestart("/memory", {}, { expectedLease: current })).toMatchObject({
    status: "accepted",
    oldPid: 42,
  })
  expect(fixture.spawn).toHaveBeenCalledOnce()
})
