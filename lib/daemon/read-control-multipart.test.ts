import { afterEach, expect, it, vi } from "vitest"
import { readControlMultipart } from "@/daemon/read-control-multipart"
import { errorDetails } from "@/error-details"

afterEach(() => vi.useRealTimers())

it("accepts multipart file bytes and command fields", async () => {
  const form = new FormData()
  form.set("command", "{}")
  form.set("file", new Blob([new Uint8Array([0, 255, 1])]), "bytes.bin")
  const result = await readControlMultipart(
    new Request("http://localhost/slack", { method: "POST", body: form }),
  )
  expect(result.get("command")).toBe("{}")
  const file = result.get("file")
  if (!(file instanceof Blob)) throw Error("Missing file")
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 255, 1]))
})

it.each(["abort", "timeout", "cleanup-stall"])(
  "bounds stalled multipart reception: %s",
  async (mode) => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const cancel = vi.fn(() => (mode === "cleanup-stall" ? new Promise<void>(() => {}) : undefined))
    const body = new ReadableStream<Uint8Array>({ cancel })
    const request = new Request("http://localhost/slack", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body,
      duplex: "half",
      signal: controller.signal,
    })
    const pending = readControlMultipart(request).catch((error: unknown) => error)
    if (mode === "abort") controller.abort(new Error("Caller cancelled"))
    await vi.advanceTimersByTimeAsync(mode === "abort" ? 0 : 61000)
    const failure = await pending
    expect(failure).toMatchObject({
      code: "USAGE",
      details: { phase: "control-body", executionStarted: false },
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    if (mode === "cleanup-stall")
      expect(
        errorDetails(failure).some((cause) => cause.message.includes("cancellation timed out")),
      ).toBe(true)
  },
)
