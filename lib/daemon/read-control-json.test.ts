import { MAX_CONTROL_JSON_BYTES } from "@/daemon/control-input-limits"
import { afterEach, expect, it, vi } from "vitest"
import { readControlJson } from "@/daemon/read-control-json"
import { errorDetails } from "@/error-details"

afterEach(() => vi.useRealTimers())

function streamRequest(body: ReadableStream<Uint8Array>): Request {
  return new Request("http://localhost/turn", { method: "POST", body, duplex: "half" })
}

it("enforces the actual byte limit without relying on Content-Length", async () => {
  const request = new Request("http://localhost/turn", {
    method: "POST",
    body: JSON.stringify("a".repeat(MAX_CONTROL_JSON_BYTES)),
  })
  const failure = await readControlJson(request).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "USAGE",
    details: { phase: "control-body", executionStarted: false },
  })
  expect(errorDetails(failure).some((cause) => cause.message.includes("exceeded"))).toBe(true)
})

it("accepts JSON exactly at the byte limit", async () => {
  const text = "a".repeat(MAX_CONTROL_JSON_BYTES - 2)
  const request = new Request("http://localhost/turn", {
    method: "POST",
    body: JSON.stringify(text),
  })
  expect(await readControlJson(request)).toBe(text)
})

it("bounds stalled body reception and releases its reader before cancellation", async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const pending = readControlJson(streamRequest(new ReadableStream<Uint8Array>({ cancel }))).catch(
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(5000)
  const failure = await pending
  expect(failure).toMatchObject({
    code: "USAGE",
    details: { phase: "control-body", executionStarted: false },
  })
  expect(errorDetails(failure).some((cause) => cause.message.includes("receive timed out"))).toBe(
    true,
  )
  expect(cancel).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("retains timeout and cleanup failure when cancellation also stalls", async () => {
  vi.useFakeTimers()
  const pending = readControlJson(
    streamRequest(
      new ReadableStream<Uint8Array>({
        async cancel(): Promise<void> {
          return new Promise(() => {})
        },
      }),
    ),
  ).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(6000)
  const failure = await pending
  expect(failure).toMatchObject({
    code: "USAGE",
    details: { phase: "control-body", executionStarted: false },
  })
  const causes = errorDetails(failure)
  expect(causes.some((cause) => cause.message.includes("receive timed out"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("cancellation timed out"))).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("preserves invalid JSON parsing causes", async () => {
  const request = new Request("http://localhost/turn", { method: "POST", body: "invalid" })
  const failure = await readControlJson(request).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "USAGE",
    details: { phase: "control-body", executionStarted: false },
  })
  const causes = errorDetails(failure)
  expect(causes.some((cause) => cause.name === "SyntaxError")).toBe(true)
})
