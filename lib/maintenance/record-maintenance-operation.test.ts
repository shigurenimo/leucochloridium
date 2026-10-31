import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { MemoryMaintenanceStore } from "@/maintenance/memory-maintenance-store"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { errorDetails } from "@/error-details"
const fixture = vi.hoisted(() => {
  const state: { store: MaintenanceStore | null } = { store: null }
  return { state, append: vi.fn(), close: vi.fn(), health: vi.fn(), configure: vi.fn() }
})
vi.mock("node:fs", () => ({ existsSync: () => false, chmodSync: vi.fn() }))
vi.mock("@/events/leuco-event-log", () => ({
  LeucoEventLog: class {
    constructor(props: unknown) {
      fixture.configure(props)
    }
    append = fixture.append
    close = fixture.close
    getHealth = fixture.health
  },
}))
vi.mock("@/maintenance/node-maintenance-store", () => ({
  NodeMaintenanceStore: class {
    writeOperation(operation: MaintenanceOperation) {
      fixture.state.store?.writeOperation(operation)
    }
    updateOperation(
      id: string,
      transform: (operation: MaintenanceOperation) => MaintenanceOperation,
    ) {
      return fixture.state.store?.updateOperation(id, transform) ?? null
    }
  },
}))
const operation: MaintenanceOperation = {
  id: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
  status: "accepted",
  requestedAt: 1,
  updatedAt: 1,
  workerPid: null,
  oldPid: null,
  oldLeaseId: null,
  recovery: null,
  newPid: null,
  error: null,
  launch: { workingDirectory: "/memory", codexHome: null },
}
beforeEach(() => {
  fixture.state.store = new MemoryMaintenanceStore()
  fixture.configure.mockReset()
  fixture.append.mockReset()
  fixture.close.mockReset()
  fixture.health.mockReset().mockReturnValue({ lastWriteFailed: false })
  vi.spyOn(process.stderr, "write").mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())
it("keeps event append and close errors without undoing the authoritative journal", () => {
  fixture.append.mockImplementationOnce(() => {
    throw Object.assign(new Error("append failed"), { code: "EIO" })
  })
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EBUSY" })
  })
  expect(recordMaintenanceOperation("/memory", operation)).toBe(true)
  expect(fixture.state.store?.readOperation()).toMatchObject({
    status: "accepted",
    eventLogCauses: expect.arrayContaining([
      expect.objectContaining({ code: "EIO" }),
      expect.objectContaining({ code: "EBUSY" }),
    ]),
  })
})
it("keeps diagnostics in the authoritative journal without attempting stderr", () => {
  fixture.append.mockImplementationOnce(() => {
    throw Object.assign(new Error("append failed"), { code: "EIO" })
  })
  vi.mocked(process.stderr.write).mockImplementationOnce(() => {
    throw Object.assign(new Error("stderr failed"), { code: "EPIPE" })
  })
  expect(() => recordMaintenanceOperation("/memory", operation)).not.toThrow()
  expect(fixture.state.store?.readOperation()).toMatchObject({
    eventLogCauses: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
  })
  expect(process.stderr.write).not.toHaveBeenCalled()
  expect(fixture.configure).toHaveBeenCalledWith(
    expect.objectContaining({ diagnosticOutput: null }),
  )
})
it("preserves a SQLite diagnostic snapshot instead of dropping its OS code", () => {
  fixture.health.mockReturnValue({
    lastWriteFailed: true,
    lastPersistError: {
      message: "database busy",
      causes: errorDetails(Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" })),
    },
  })
  expect(recordMaintenanceOperation("/memory", operation)).toBe(true)
  expect(fixture.state.store?.readOperation()).toMatchObject({
    eventLogCauses: expect.arrayContaining([expect.objectContaining({ code: "SQLITE_BUSY" })]),
  })
})
it("distinguishes a committed journal from failure to save its diagnostic annotation", () => {
  fixture.append.mockImplementationOnce(() => {
    throw Object.assign(new Error("append failed"), { code: "EIO" })
  })
  vi.spyOn(fixture.state.store!, "updateOperation").mockImplementationOnce(() => {
    throw Object.assign(new Error("annotation failed"), { code: "EDQUOT" })
  })
  const failure = (() => {
    try {
      return recordMaintenanceOperation("/memory", operation)
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { journalWritten: true, operationId: operation.id },
  })
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EIO", "EDQUOT"]),
  )
  expect(fixture.state.store?.readOperation()?.id).toBe(operation.id)
})
it("does not report ownership after another operation replaced the journal during event persistence", () => {
  const next = { ...operation, id: "7e6d9bcc-a07c-4c72-93f0-7eb651f9711d" }
  fixture.append.mockImplementationOnce(() => {
    fixture.state.store?.writeOperation(next)
    throw new Error("event failed")
  })
  expect(recordMaintenanceOperation("/memory", operation)).toBe(false)
  expect(fixture.state.store?.readOperation()).toEqual(next)
})

it("keeps event, close and annotation failures together without another reporting channel", () => {
  const write = Object.assign(new Error("append failed"), { code: "EIO" })
  fixture.append.mockImplementationOnce(() => {
    throw write
  })
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EBUSY" })
  })
  vi.spyOn(fixture.state.store!, "updateOperation").mockImplementationOnce(() => {
    throw Object.assign(new Error("annotation failed"), { code: "EDQUOT" })
  })
  const failure = (() => {
    try {
      return recordMaintenanceOperation("/memory", operation)
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({ code: "STATE_UNCERTAIN", details: { journalWritten: true } })
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EIO", "EBUSY", "EDQUOT"]),
  )
  expect(process.stderr.write).not.toHaveBeenCalled()
})

it("clears the current event error after recovery while keeping its historical causes", () => {
  fixture.append.mockImplementationOnce(() => {
    throw Object.assign(new Error("append failed"), { code: "EIO" })
  })
  expect(recordMaintenanceOperation("/memory", operation)).toBe(true)
  expect(
    recordMaintenanceOperation("/memory", { ...operation, status: "starting" }, operation.id),
  ).toBe(true)
  expect(fixture.state.store?.readOperation()).toMatchObject({
    status: "starting",
    eventLogError: null,
    eventLogCauses: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
  })
})
it("does not resurrect an event error carried by an older worker snapshot", () => {
  fixture.append.mockImplementationOnce(() => {
    throw Object.assign(new Error("append failed"), { code: "EIO" })
  })
  recordMaintenanceOperation("/memory", operation)
  const stale = fixture.state.store!.readOperation()!
  expect(recordMaintenanceOperation("/memory", { ...stale, status: "starting" }, stale.id)).toBe(
    true,
  )
  expect(recordMaintenanceOperation("/memory", { ...stale, status: "ready" }, stale.id)).toBe(true)
  expect(fixture.state.store?.readOperation()).toMatchObject({
    status: "ready",
    eventLogError: null,
    eventLogCauses: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
  })
})
it("marks journal recovery annotation failure as uncertain after progress was committed", () => {
  const prior = {
    ...operation,
    eventLogError: "previous mirror failure",
    eventLogCauses: errorDetails(Object.assign(new Error("previous failure"), { code: "EIO" })),
  }
  const store = fixture.state.store!
  store.writeOperation(prior)
  const update = store.updateOperation.bind(store)
  vi.spyOn(store, "updateOperation")
    .mockImplementationOnce(update)
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("recovery annotation failed"), { code: "EDQUOT" })
    })
  const failure = (() => {
    try {
      return recordMaintenanceOperation("/memory", { ...prior, status: "starting" }, prior.id)
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { journalWritten: true, operationId: prior.id },
  })
  expect(errorDetails(failure).map((cause) => cause.code)).toContain("EDQUOT")
  expect(store.readOperation()?.status).toBe("starting")
})

it.each([false, true])(
  "bounds the authoritative failure before saving it (existing operation: %s)",
  (existing) => {
    if (existing) fixture.state.store?.writeOperation(operation)
    const secret = "xoxb-synthetic-maintenance-private-token-123456789"
    const message = `${"p".repeat(3970)}${secret} ${"q".repeat(17 * 1024 * 1024)}`
    const failed: MaintenanceOperation = {
      ...operation,
      status: "failed",
      oldPid: 42,
      error: message,
      causes: errorDetails(Object.assign(new Error("original failure"), { code: "EBOOT" })),
    }
    expect(recordMaintenanceOperation("/memory", failed, existing ? operation.id : undefined)).toBe(
      true,
    )
    const saved = fixture.state.store?.readOperation()
    expect(saved?.error?.length).toBeLessThanOrEqual(4000)
    expect(saved?.error).toContain("[redacted]")
    expect(saved?.error).toContain("[truncated]")
    expect(saved?.error).not.toContain(secret.slice(0, 16))
    expect(saved).toMatchObject({
      id: operation.id,
      status: "failed",
      oldPid: 42,
      causes: expect.arrayContaining([expect.objectContaining({ code: "EBOOT" })]),
    })
    expect(fixture.append).toHaveBeenCalledWith(expect.objectContaining({ error: saved?.error }))
    expect(failed.error).toBe(message)
  },
)
