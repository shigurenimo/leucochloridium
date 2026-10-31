import { afterEach, expect, it, vi } from "vitest"
import { assertSlackFileResponse } from "@/actions/slack/assert-slack-file-response"
import { errorDetails } from "@/error-details"

afterEach(() => vi.useRealTimers())

it("leaves successful response bodies readable", async () => {
  const response = new Response("file")
  await assertSlackFileResponse(response)
  expect(await response.text()).toBe("file")
})

it("preserves HTTP status when closing a failed response also fails", async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("response close failed")
    },
  })
  const failure = await assertSlackFileResponse(new Response(body, { status: 403 })).catch(
    (error: unknown) => error,
  )
  const causes = errorDetails(failure)
  expect(causes.some((cause) => cause.message.includes("HTTP 403"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("response close failed"))).toBe(true)
})

it("bounds closing a failed response without hiding the HTTP status", async () => {
  vi.useFakeTimers()
  const body = new ReadableStream<Uint8Array>({
    async cancel(): Promise<void> {
      return new Promise(() => {})
    },
  })
  const pending = assertSlackFileResponse(new Response(body, { status: 503 })).catch(
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(1000)
  const causes = errorDetails(await pending)
  expect(causes.some((cause) => cause.message.includes("HTTP 503"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("cancellation timed out"))).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
