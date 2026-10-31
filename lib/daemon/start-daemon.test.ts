import { beforeEach, expect, it, vi } from "vitest"
import { startDaemon } from "@/daemon/start-daemon"
import { errorDetails } from "@/error-details"

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  ensureHome: vi.fn(),
  lease: vi.fn(),
  alive: vi.fn(),
  close: vi.fn(),
  child: { pid: 42, on: vi.fn(), unref: vi.fn() },
}))
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
vi.mock("@/storage/node-leuco-store", () => ({
  NodeLeucoStore: class {
    ensureHome = fixture.ensureHome
  },
}))
beforeEach(() => {
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
it("rejects an existing daemon without changing home permissions or spawning", async () => {
  fixture.lease.mockReturnValue({ pid: 42, token: "synthetic-owner" })
  fixture.alive.mockReturnValue(true)
  await expect(startDaemon("/memory", parsed)).rejects.toMatchObject({ code: "STATE_CONFLICT" })
  expect(fixture.ensureHome).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
})
