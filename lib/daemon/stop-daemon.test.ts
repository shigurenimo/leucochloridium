import { afterEach, expect, it, vi } from "vitest"
import { stopDaemon } from "@/daemon/stop-daemon"
import { requestDaemon } from "@/daemon/request-daemon"

vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: () => ({ pid: 42, token: "synthetic-control-token" }),
  isProcessAlive: () => true,
}))
vi.mock("@/daemon/request-daemon", () => ({
  requestDaemon: vi.fn(async () => ({ stopped: true, processWillExit: true })),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it("bounds process-exit observation when the wall clock moves backwards", async () => {
  vi.useFakeTimers()
  vi.stubGlobal("Bun", {
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  })
  const observed: { failure: unknown } = { failure: null }
  const pending = stopDaemon({ home: "/memory", requestId: "stop-probe" }).catch(
    (error: unknown) => {
      observed.failure = error
    },
  )
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
  vi.stubGlobal("Bun", {
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  })
  const controller = new AbortController()
  const observed: { failure: unknown } = { failure: null }
  const pending = stopDaemon({
    home: "/memory",
    requestId: "cancel-stop",
    signal: controller.signal,
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
