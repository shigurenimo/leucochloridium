import { beforeEach, expect, it, vi } from "vitest"
import { repairRuntime } from "@/maintenance/repair-runtime"
import { errorDetails } from "@/error-details"

const fixture = vi.hoisted(() => ({
  release: vi.fn(),
  writeBackup: vi.fn(),
  writeState: vi.fn(),
  readState: vi.fn(),
  beforeLock: vi.fn(),
  openBackup: vi.fn(),
  syncBackup: vi.fn(),
  closeBackup: vi.fn(),
}))
vi.mock("@/cli/inspect-diagnostic-history", () => ({
  inspectDiagnosticHistory: () => ({ eventLogValid: true, errors: [] }),
}))
vi.mock("@/maintenance/node-maintenance-store", () => ({
  NodeMaintenanceStore: class {
    readOperation() {
      return null
    }
  },
}))
vi.mock("@/storage/node-leuco-store", () => ({
  NodeLeucoStore: class {
    loadSettings() {
      return {}
    }
    loadState() {
      return fixture.readState()
    }
    ensureHome() {}
  },
}))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: () => null,
  isProcessAlive: () => false,
  acquireDaemonLease: () => ({ pid: 42, token: "synthetic-reservation-secret" }),
  releaseDaemonLease: fixture.release,
}))
vi.mock("@/fs/read-regular-bytes", () => ({
  readRegularBytes: () => Buffer.from([0x80, 0xff, 0xf0, 0x9f]),
}))
vi.mock("@/fs/atomic-write-json", () => ({ atomicWriteJson: fixture.writeState }))
vi.mock("@/fs/with-file-lock", () => ({
  withFileLock: (props: { lockPath: string }, operation: () => unknown) => {
    fixture.beforeLock(props.lockPath)
    return operation()
  },
}))
vi.mock("node:fs", () => ({
  writeFileSync: fixture.writeBackup,
  openSync: fixture.openBackup,
  fsyncSync: fixture.syncBackup,
  closeSync: fixture.closeBackup,
}))

beforeEach(() => {
  fixture.release.mockReset().mockImplementation(() => {
    throw Object.assign(new Error("release failed synthetic-reservation-secret"), { code: "EIO" })
  })
  fixture.writeBackup.mockReset()
  fixture.writeState.mockReset()
  fixture.readState.mockReset().mockImplementation(() => {
    throw new SyntaxError("damaged state")
  })
  fixture.beforeLock.mockReset()
  fixture.openBackup.mockReset().mockReturnValue(42)
  fixture.syncBackup.mockReset()
  fixture.closeBackup.mockReset()
})

it.each(["sync", "close", "both"])("retains state when backup %s fails", async (phase) => {
  fixture.release.mockReturnValueOnce(true)
  if (phase !== "close")
    fixture.syncBackup.mockImplementation(() => {
      throw Object.assign(new Error("backup sync failed"), { code: "EIO" })
    })
  if (phase !== "sync")
    fixture.closeBackup.mockImplementation(() => {
      throw Object.assign(new Error("backup close failed"), { code: "EBUSY" })
    })
  const failure = await repairRuntime("/memory", { resetState: true }).catch(
    (error: unknown) => error,
  )
  expect(fixture.writeState).not.toHaveBeenCalled()
  expect(fixture.closeBackup).toHaveBeenCalledExactlyOnceWith(42)
  const codes = errorDetails(failure).map((cause) => cause.code)
  if (phase !== "close") expect(codes).toContain("EIO")
  if (phase !== "sync") expect(codes).toContain("EBUSY")
  expect(fixture.release).toHaveBeenCalledOnce()
})

it("confirms backup sync and closure before replacing state", async () => {
  fixture.writeState.mockImplementation(() => {
    expect(fixture.syncBackup).toHaveBeenCalledExactlyOnceWith(42)
    expect(fixture.closeBackup).toHaveBeenCalledExactlyOnceWith(42)
  })
  const failure = await repairRuntime("/memory", { resetState: true }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ details: { operationCompleted: true } })
})

it("preserves state that became valid before the reset lock", async () => {
  fixture.release.mockReturnValueOnce(true)
  fixture.beforeLock.mockImplementation((path: string) => {
    if (path === "/memory/state.lock") fixture.readState.mockReturnValue({ threads: {} })
  })
  const failure = await repairRuntime("/memory", { resetState: true }).catch(
    (error: unknown) => error,
  )
  expect(fixture.writeState).not.toHaveBeenCalled()
  expect(fixture.writeBackup).not.toHaveBeenCalled()
  expect(failure).toMatchObject({ code: "STATE_CONFLICT", details: { phase: "state-reset" } })
  expect(fixture.release).toHaveBeenCalledOnce()
})

it("does not inspect or reset state for a pre-cancelled repair", async () => {
  const reason = new Error("caller cancelled repair")
  await expect(
    repairRuntime("/memory", { resetState: true, signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason)
  expect(fixture.readState).not.toHaveBeenCalled()
  expect(fixture.writeBackup).not.toHaveBeenCalled()
  expect(fixture.writeState).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
})
it("retains backup and reservation-release failures during state repair", async () => {
  fixture.writeBackup.mockImplementation(() => {
    throw Object.assign(new Error("backup failed"), { code: "EACCES" })
  })
  const failure = await repairRuntime("/memory", { resetState: true }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "reservation-release", operationCompleted: false },
  })
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EACCES", "EIO"]),
  )
  expect(JSON.stringify(errorDetails(failure))).not.toContain("synthetic-reservation-secret")
  expect(fixture.writeState).not.toHaveBeenCalled()
  expect(fixture.release).toHaveBeenCalledOnce()
})
it("reports that reset completed when only reservation release failed", async () => {
  const failure = await repairRuntime("/memory", { resetState: true }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "reservation-release", operationCompleted: true },
  })
  expect(fixture.writeBackup).toHaveBeenCalledOnce()
  expect(fixture.writeBackup).toHaveBeenCalledWith(42, Buffer.from([0x80, 0xff, 0xf0, 0x9f]))
  expect(fixture.openBackup).toHaveBeenCalledWith(
    expect.stringMatching(/^\/memory\/state\.invalid\./),
    "wx",
    0o600,
  )
  expect(fixture.writeState).toHaveBeenCalledExactlyOnceWith({
    path: "/memory/state.json",
    data: { threads: {}, scheduleLastFiredAt: {} },
    mode: 0o600,
  })
  expect(fixture.release).toHaveBeenCalledOnce()
})
