import { afterEach, expect, it, vi } from "vitest"
import { assertSlackReplyActive } from "@/runtime/assert-slack-reply-active"
import { errorDetails } from "@/error-details"

afterEach(() => vi.useRealTimers())

it("preserves cancellation and disposal failure for a late response", async () => {
  const controller = new AbortController()
  controller.abort(new Error("caller cancelled"))
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("disposal failed")
    },
  })
  const causes = errorDetails(
    await assertSlackReplyActive(new Response(body), controller.signal).catch(
      (error: unknown) => error,
    ),
  )
  expect(causes.some((cause) => cause.message.includes("caller cancelled"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("disposal failed"))).toBe(true)
})

it("bounds disposal of a late response after cancellation", async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  controller.abort(new Error("caller cancelled"))
  const body = new ReadableStream<Uint8Array>({
    async cancel(): Promise<void> {
      return new Promise(() => {})
    },
  })
  const pending = assertSlackReplyActive(new Response(body), controller.signal).catch(
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(1000)
  const causes = errorDetails(await pending)
  expect(causes.some((cause) => cause.message.includes("caller cancelled"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("disposal timed out"))).toBe(true)
})
