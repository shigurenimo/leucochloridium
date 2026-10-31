import { beforeEach, expect, it, vi } from "vitest"
import { repairRuntime } from "@/maintenance/repair-runtime"

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  request: vi.fn(),
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
vi.mock("@/storage/node-leuco-store", async () => {
  const memory = await import("@/storage/memory-leuco-store")
  return {
    NodeLeucoStore: class extends memory.MemoryLeucoStore {
      constructor() {
        super()
      }
      ensureHome() {}
    },
  }
})
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: fixture.read,
  isProcessAlive: () => false,
  releaseDaemonLease: fixture.release,
}))
vi.mock("@/daemon/request-daemon", () => ({ requestDaemon: fixture.request }))
vi.mock("@/fs/with-file-lock", () => ({
  withFileLock: (_props: unknown, operation: () => unknown) => operation(),
}))
vi.mock("node:fs", () => ({ existsSync: () => false, rmSync: fixture.remove }))
beforeEach(() => {
  fixture.read
    .mockReset()
    .mockReturnValueOnce({ pid: 42, token: "old-owner" })
    .mockReturnValue(null)
  fixture.release.mockReset().mockReturnValue(true)
  fixture.remove.mockReset()
  fixture.request.mockReset()
})
it("does not claim successful repair when stale ownership changed before release", async () => {
  fixture.release.mockReturnValueOnce(false)
  const failure = await repairRuntime("/memory", { resetState: false }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_CONFLICT",
    details: { phase: "identity", previousPid: 42, actions: [] },
  })
  expect(fixture.remove).not.toHaveBeenCalled()
  expect(fixture.request).not.toHaveBeenCalled()
})
it("reports stale cleanup only after confirmed removal", async () => {
  expect(await repairRuntime("/memory", { resetState: false })).toMatchObject({
    repaired: true,
    actions: ["Removed confirmed stale daemon lease and control socket"],
    restart: null,
  })
  expect(fixture.release).toHaveBeenCalledOnce()
  expect(fixture.request).not.toHaveBeenCalled()
})
