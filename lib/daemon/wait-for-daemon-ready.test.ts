import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { waitForDaemonReady } from "@/daemon/wait-for-daemon-ready"
import { requestDaemon } from "@/daemon/request-daemon"
import { errorDetails } from "@/error-details"

vi.mock("@/daemon/request-daemon", () => ({ requestDaemon: vi.fn() }))
const waiting = { running: true, ready: false, pid: 42, cwd: "/work" }
const props = { home: "/memory", pid: 42, timeoutMs: 50, pollMs: 10 }
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(requestDaemon).mockReset().mockResolvedValue(waiting)
})
afterEach(() => vi.useRealTimers())

it("keeps the observation budget when the wall clock moves backwards", async () => {
  const observed: { failure: unknown } = { failure: null }
  const pending = waitForDaemonReady(props).catch((error: unknown) => {
    observed.failure = error
  })
  await vi.advanceTimersByTimeAsync(5)
  vi.setSystemTime(Date.now() - 60000)
  await vi.advanceTimersByTimeAsync(50)
  expect(observed.failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "readiness" },
  })
  await pending
})

it("retains the last status separately from a previous failed observation", async () => {
  const reason = new Error("ownership verification failed")
  vi.mocked(requestDaemon).mockRejectedValueOnce(reason)
  const pending = waitForDaemonReady(props).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(50)
  const failure = await pending
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: {
      phase: "readiness",
      pid: 42,
      lastStatus: { pid: 42, ready: false },
      lastProbeFailure: {
        causes: expect.arrayContaining([expect.objectContaining({ message: reason.message })]),
      },
    },
  })
  expect(errorDetails(failure).some((cause) => cause.message === reason.message)).toBe(true)
  expect(String(failure)).not.toContain("still starting")
})

it("only confirms readiness for the spawned child PID", async () => {
  vi.mocked(requestDaemon)
    .mockResolvedValueOnce({ ...waiting, ready: true, pid: 99 })
    .mockResolvedValueOnce({ ...waiting, ready: true })
  const pending = waitForDaemonReady(props)
  await vi.advanceTimersByTimeAsync(10)
  expect(await pending).toMatchObject({ pid: 42, ready: true })
  expect(requestDaemon).toHaveBeenCalledTimes(2)
})

it("returns the confirmed child exit failure without replacing its diagnostics", async () => {
  const exit = new Error("confirmed child exit")
  await expect(waitForDaemonReady({ ...props, getExitError: () => exit })).rejects.toBe(exit)
  expect(requestDaemon).not.toHaveBeenCalled()
})

it("does not accept a buffered ready status after observing child exit", async () => {
  const exit = new Error("child exited during probe")
  const getExitError = vi.fn<() => Error | null>().mockReturnValueOnce(null).mockReturnValue(exit)
  vi.mocked(requestDaemon).mockResolvedValue({ ...waiting, ready: true })
  await expect(waitForDaemonReady({ ...props, getExitError })).rejects.toBe(exit)
})

it("cancels observation without starting or replaying work", async () => {
  const controller = new AbortController()
  const reason = new Error("caller deadline")
  const pending = waitForDaemonReady({ ...props, signal: controller.signal }).catch(
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(5)
  controller.abort(reason)
  const failure = await pending
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "readiness", cancelled: true },
  })
  expect(errorDetails(failure).some((cause) => cause.message === reason.message)).toBe(true)
  expect(
    vi
      .mocked(requestDaemon)
      .mock.calls.every((call) => call[0].path === "/status" && call[0].body === undefined),
  ).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("retains a confirmed child exit during the final readiness polling delay", async () => {
  const exit = Object.assign(new Error("child exited before the observation deadline"), {
    code: "EPIPE",
  })
  const child: { failure: Error | null } = { failure: null }
  const pending = waitForDaemonReady({ ...props, getExitError: () => child.failure }).catch(
    (error: unknown) => error,
  )
  setTimeout(() => {
    child.failure = exit
  }, 45)
  await vi.advanceTimersByTimeAsync(50)
  expect(await pending).toBe(exit)
  expect(vi.getTimerCount()).toBe(0)
})
