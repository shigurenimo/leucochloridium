import { afterEach, expect, it, vi } from "vitest"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { errorDetails } from "@/error-details"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

afterEach(() => vi.useRealTimers())

it("does not start an API request when the caller already cancelled", async () => {
  const controller = new AbortController()
  controller.abort(new Error("caller cancelled"))
  const fetchFn = vi.fn(async () => Response.json({ ok: true }))
  const props = { botToken: "test", fetchFn, signal: controller.signal }
  const client = new LeucoFetchSlackWebClient(props)
  await expect(client.authTest()).rejects.toThrow("caller cancelled")
  expect(fetchFn).not.toHaveBeenCalled()
})

it.each(["10", ""])("cancels the 429 wait (%j) without issuing another request", async (header) => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const fetchFn = vi.fn(
    async () =>
      new Response("limited", {
        status: 429,
        headers: { "Retry-After": header },
      }),
  )
  const props = { botToken: "test", fetchFn, signal: controller.signal }
  const client = new LeucoFetchSlackWebClient(props)
  const observed: { failure: unknown } = { failure: null }
  const pending = client.authTest().catch((error: unknown) => {
    observed.failure = error
  })
  await vi.advanceTimersByTimeAsync(1)
  controller.abort(new Error("caller cancelled"))
  await vi.advanceTimersByTimeAsync(0)
  expect(String(observed.failure)).toContain("caller cancelled")
  await pending
  expect(fetchFn).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it("honors cancellation while confirming upload response cleanup", async () => {
  const controller = new AbortController()
  const cleanupStarted = Promise.withResolvers<void>()
  const finishCleanup = Promise.withResolvers<void>()
  const fetchFn = vi.fn(async (url: string | URL | Request): Promise<Response> => {
    if (String(url).endsWith("/files.getUploadURLExternal"))
      return Response.json({
        ok: true,
        upload_url: "https://files.slack.com/upload/test",
        file_id: "F1",
      })
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cleanupStarted.resolve()
          return finishCleanup.promise
        },
      }),
    )
  })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    fetchFn,
    signal: controller.signal,
  })
  const pending = client.filesUpload({
    content: new Uint8Array([1]),
    filename: "test.txt",
    title: "Test",
    channelId: "C1",
    threadTs: null,
    initialComment: null,
  })
  const rejected = expect(pending).rejects.toThrow("caller cancelled")
  await cleanupStarted.promise
  controller.abort(new Error("caller cancelled"))
  finishCleanup.resolve()
  await rejected
  expect(fetchFn).toHaveBeenCalledTimes(2)
})

it("stops waiting when fetch ignores its abort signal without retrying a write", async () => {
  vi.useFakeTimers()
  const fetchFn = vi.fn(async (): Promise<Response> => new Promise(() => {}))
  const client = new LeucoFetchSlackWebClient({ botToken: "test", requestTimeoutMs: 20, fetchFn })
  const observed: { failure: unknown } = { failure: null }
  const pending = client
    .apiCall("chat.postMessage", { channel: "C1", text: "test" })
    .catch((error: unknown) => {
      observed.failure = error
    })
  await vi.advanceTimersByTimeAsync(20)
  expect(String(observed.failure)).toContain("timed out after 20ms")
  await pending
  expect(fetchFn).toHaveBeenCalledOnce()
})

it("bounds reading a response body that ignores abort", async () => {
  vi.useFakeTimers()
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    requestTimeoutMs: 20,
    fetchFn: async () => new Response(body),
  })
  const observed: { failure: unknown } = { failure: null }
  const pending = client.authTest().catch((error: unknown) => {
    observed.failure = error
  })
  await vi.advanceTimersByTimeAsync(20)
  expect(String(observed.failure)).toContain("timed out after 20ms")
  await pending
  expect(cancel).toHaveBeenCalledOnce()
})

it("does not retry a rate limit response whose cleanup failed", async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("cleanup failed")
    },
  })
  const fetchFn = vi.fn(
    async () =>
      new Response(body, {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
  )
  const client = new LeucoFetchSlackWebClient({ botToken: "test", fetchFn })
  const failure = await client.authTest().catch((error: unknown) => error)
  expect(errorDetails(failure).some((cause) => cause.message.includes("cleanup failed"))).toBe(true)
  expect(errorDetails(failure).some((cause) => cause.message.includes("http 429"))).toBe(true)
  expect(fetchFn).toHaveBeenCalledOnce()
})

it("preserves HTTP failure when cleanup fails too", async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("cleanup failed")
    },
  })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    fetchFn: async () => new Response(body, { status: 503 }),
  })
  const causes = errorDetails(await client.authTest().catch((error: unknown) => error))
  expect(causes.some((cause) => cause.message.includes("http 503"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("cleanup failed"))).toBe(true)
})

it("bounds cleanup without replacing the HTTP failure", async () => {
  vi.useFakeTimers()
  const body = new ReadableStream<Uint8Array>({
    async cancel(): Promise<void> {
      return new Promise(() => {})
    },
  })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    fetchFn: async () => new Response(body, { status: 503 }),
  })
  const pending = client.authTest().catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(1000)
  const causes = errorDetails(await pending)
  expect(causes.some((cause) => cause.message.includes("http 503"))).toBe(true)
  expect(causes.some((cause) => cause.message.includes("cancellation timed out"))).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it("never completes sharing after an external upload times out", async () => {
  vi.useFakeTimers()
  const fetchFn = vi.fn(async (url: string | URL | Request): Promise<Response> => {
    if (String(url).endsWith("/files.getUploadURLExternal"))
      return Response.json({
        ok: true,
        upload_url: "https://files.slack.com/upload/test",
        file_id: "F1",
      })
    return new Promise(() => {})
  })
  const client = new LeucoFetchSlackWebClient({ botToken: "test", requestTimeoutMs: 20, fetchFn })
  const observed: { failure: unknown } = { failure: null }
  const pending = client
    .filesUpload({
      content: new Uint8Array([1]),
      filename: "test.txt",
      title: "Test",
      channelId: "C1",
      threadTs: null,
      initialComment: null,
    })
    .catch((error: unknown) => {
      observed.failure = error
    })
  await vi.advanceTimersByTimeAsync(20)
  expect(String(observed.failure)).toContain("slack file upload timed out after 20ms")
  await pending
  expect(fetchFn).toHaveBeenCalledTimes(2)
})

it("preserves the JSON parsing cause", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("invalid"))
      stream.close()
    },
  })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    fetchFn: async () => new Response(body),
  })
  const causes = errorDetails(await client.authTest().catch((error: unknown) => error))
  expect(causes.some((cause) => cause.message.includes("not valid JSON"))).toBe(true)
  expect(causes.some((cause) => cause.name === "SyntaxError")).toBe(true)
})

it("decodes UTF-8 across response chunk boundaries", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ ok: true, user_id: "あ" }))
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      for (const byte of encoded) stream.enqueue(new Uint8Array([byte]))
      stream.close()
    },
  })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    fetchFn: async () => new Response(body),
  })
  await expect(client.authTest()).resolves.toEqual({ userId: "あ", botId: null })
})

it("rejects non-byte response chunks and closes the body", async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<string>({
    start(stream) {
      stream.enqueue("invalid bytes")
    },
    cancel,
  })
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    fetchFn: async () => new Response(body),
  })
  await expect(client.authTest()).rejects.toThrow("invalid byte chunk")
  expect(cancel).toHaveBeenCalledOnce()
})

it.each([MAX_TIMER_DELAY_MS + 1, Number.MAX_SAFE_INTEGER])(
  "rejects an overflowing Slack request timeout %s before sending",
  async (requestTimeoutMs) => {
    const fetchFn = vi.fn(async () => Response.json({ ok: true, user_id: "U1" }))
    const client = new LeucoFetchSlackWebClient({ botToken: "test", requestTimeoutMs, fetchFn })
    await expect(client.authTest()).rejects.toThrow(`between 1 and ${MAX_TIMER_DELAY_MS}`)
    expect(fetchFn).not.toHaveBeenCalled()
  },
)

it("accepts the maximum Slack request timer and clears it after completion", async () => {
  vi.useFakeTimers()
  const fetchFn = vi.fn(async () => Response.json({ ok: true, user_id: "U1" }))
  const client = new LeucoFetchSlackWebClient({
    botToken: "test",
    requestTimeoutMs: MAX_TIMER_DELAY_MS,
    fetchFn,
  })
  await expect(client.authTest()).resolves.toEqual({ userId: "U1", botId: null })
  expect(vi.getTimerCount()).toBe(0)
})

it("waits the default second before retrying a blank Retry-After header", async () => {
  vi.useFakeTimers()
  const fetchFn = vi.fn(async (): Promise<Response> =>
    fetchFn.mock.calls.length === 1
      ? new Response("limited", { status: 429, headers: { "Retry-After": " \t " } })
      : Response.json({ ok: true, user_id: "U1" }),
  )
  const client = new LeucoFetchSlackWebClient({ botToken: "test", fetchFn })
  const pending = client.authTest()
  await vi.advanceTimersByTimeAsync(999)
  expect(fetchFn).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  await expect(pending).resolves.toEqual({ userId: "U1", botId: null })
  expect(fetchFn).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
