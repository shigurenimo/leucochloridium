import { afterEach, describe, expect, it, vi } from "vitest"
import { awaitDownloadStep } from "@/fs/await-download-step"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { DownloadFileTransfer } from "@/fs/download-file-transfer"

afterEach(() => vi.useRealTimers())
describe("download deadlines independent of transport cooperation", () => {
  it("ends idle waiting and signals cancellation even when the operation never settles", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = awaitDownloadStep(new Promise<void>(() => {}), controller, 20)
    const rejected = expect(pending).rejects.toThrow("20ms without data")
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(controller.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("honors cancellation before the idle deadline and observes later rejection", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const operation = Promise.withResolvers<string>()
    const pending = awaitDownloadStep(operation.promise, controller, 1000)
    const reason = new Error("caller aborted")
    const rejected = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejected
    operation.reject(new Error("late transport rejection"))
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("bounds cleanup even when cancellation never acknowledges", async () => {
    vi.useFakeTimers()
    const pending = awaitBoundedCleanup(new Promise<void>(() => {}), "body cancellation", 20)
    const rejected = expect(pending).rejects.toThrow("body cancellation timed out after 20ms")
    await vi.advanceTimersByTimeAsync(20)
    await rejected
  })
  it("removes timers on successful completion without aborting the caller", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    expect(await awaitDownloadStep(Promise.resolve("done"), controller, 20)).toBe("done")
    expect(await awaitBoundedCleanup(Promise.resolve("closed"), "close", 20)).toBe("closed")
    expect(controller.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it("does not accept a resolved result if cancellation was already requested", async () => {
    const controller = new AbortController()
    const reason = new Error("already cancelled")
    controller.abort(reason)
    await expect(awaitDownloadStep(Promise.resolve("late value"), controller, 20)).rejects.toBe(
      reason,
    )
  })
  it("rejects reuse of a resource owner without starting another fetch", async () => {
    const controller = new AbortController()
    const reason = new Error("cancel before starting")
    controller.abort(reason)
    const fetchResponse = vi.fn(async () => new Response("unused"))
    const transfer = new DownloadFileTransfer({
      fetchResponse,
      outputPath: "/unused",
      maxBytes: 10,
      timeoutMs: 100,
      idleTimeoutMs: 100,
      signal: controller.signal,
    })
    await expect(transfer.run()).rejects.toBe(reason)
    await expect(transfer.run()).rejects.toThrow("only run once")
    expect(fetchResponse).not.toHaveBeenCalled()
  })
})
