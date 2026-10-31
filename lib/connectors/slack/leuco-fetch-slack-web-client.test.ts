import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

describe("LeucoFetchSlackWebClient", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("returns both Slack user and bot identities from auth.test", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, user_id: "UBOT", bot_id: "BSELF" }), {
          status: 200,
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxb-test" })

    await expect(client.authTest()).resolves.toEqual({
      userId: "UBOT",
      botId: "BSELF",
    })
  })

  it("posts search.messages as form-encoded data", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            messages: {
              matches: [
                {
                  channel: { id: "C1" },
                  user: "U1",
                  text: "<@UBOT> hi",
                  ts: "100.0",
                  permalink: "https://example.slack.com/archives/C1/p100",
                },
              ],
            },
          }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    const result = await client.apiCall("search.messages", {
      query: "<@UBOT>",
      sort: "timestamp",
      sort_dir: "desc",
      count: 50,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error("expected fetch to be called")
    const [url, init] = call
    if (init === undefined) throw new Error("expected fetch init")
    expect(url).toBe("https://slack.com/api/search.messages")
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer xoxp-test",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
    })
    const params = new URLSearchParams(String(init.body))
    expect(params.get("query")).toBe("<@UBOT>")
    expect(params.get("sort")).toBe("timestamp")
    expect(params.get("sort_dir")).toBe("desc")
    expect(params.get("count")).toBe("50")
    expect(result).toEqual({
      ok: true,
      messages: {
        matches: [
          {
            channel: { id: "C1" },
            user: "U1",
            text: "<@UBOT> hi",
            ts: "100.0",
            permalink: "https://example.slack.com/archives/C1/p100",
          },
        ],
      },
    })
  })

  it("posts conversations.list as form-encoded data", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            channels: [{ id: "D1", is_im: true }],
            response_metadata: { next_cursor: "page-2" },
          }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    const result = await client.apiCall("conversations.list", {
      types: "im",
      limit: 200,
      cursor: "page-1",
    })

    const [url, init] = onlyFetchCall(fetchMock)
    expect(url).toBe("https://slack.com/api/conversations.list")
    expectFormBody(init, {
      types: "im",
      limit: "200",
      cursor: "page-1",
    })
    expect(result).toEqual({
      ok: true,
      channels: [{ id: "D1", is_im: true }],
      response_metadata: { next_cursor: "page-2" },
    })
  })

  it("posts and preserves cursor pagination for conversations.replies", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            messages: [],
            response_metadata: { next_cursor: "page-2" },
          }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    const replies = await client.apiCall("conversations.replies", {
      channel: "D1",
      ts: "100.0",
      oldest: null,
      inclusive: null,
      limit: 100,
      cursor: "page-1",
    })

    const [url, init] = onlyFetchCall(fetchMock)
    expect(url).toBe("https://slack.com/api/conversations.replies")
    expectFormBody(init, {
      channel: "D1",
      ts: "100.0",
      limit: "100",
      cursor: "page-1",
    })
    expect(replies).toEqual({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "page-2" },
    })
  })

  it("posts files.getUploadURLExternal as form-encoded data through apiCall", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ ok: true, upload_url: "https://upload.example", file_id: "F1" }),
          {
            status: 200,
          },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    await client.apiCall("files.getUploadURLExternal", {
      filename: "banner.png",
      length: 841_529,
    })

    const [url, init] = onlyFetchCall(fetchMock)
    expect(url).toBe("https://slack.com/api/files.getUploadURLExternal")
    expectFormBody(init, {
      filename: "banner.png",
      length: "841529",
    })
  })

  it("uploads and shares a local file through Slack external upload", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).endsWith("/files.getUploadURLExternal")) {
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://files.slack.com/upload/test",
            file_id: "F1",
          }),
          { status: 200 },
        )
      }
      if (String(url) === "https://files.slack.com/upload/test") {
        return new Response("OK", { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const client = new LeucoFetchSlackWebClient({
      botToken: "xoxp-test",
      fetchFn: fetchMock,
    })

    await expect(
      client.filesUpload({
        content: new TextEncoder().encode("png"),
        filename: "banner.png",
        title: "Banner",
        channelId: "C1",
        threadTs: "100.0",
        initialComment: "done",
      }),
    ).resolves.toEqual({ fileId: "F1" })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const prepareCall = fetchMock.mock.calls[0]
    const uploadCall = fetchMock.mock.calls[1]
    const completeCall = fetchMock.mock.calls[2]
    if (prepareCall === undefined || uploadCall === undefined || completeCall === undefined) {
      throw new Error("expected three fetch calls")
    }
    expectFormBody(prepareCall[1] ?? {}, {
      filename: "banner.png",
      length: "3",
    })
    expect(String(uploadCall[0])).toBe("https://files.slack.com/upload/test")
    expect(uploadCall[1]?.body).toBeInstanceOf(FormData)
    expect(uploadCall[1]?.redirect).toBe("error")
    expect(String(completeCall[0])).toBe("https://slack.com/api/files.completeUploadExternal")
    const completeBody = new URLSearchParams(String(completeCall[1]?.body))
    expect({
      files: JSON.parse(completeBody.get("files")!),
      channel_id: completeBody.get("channel_id"),
      thread_ts: completeBody.get("thread_ts"),
      initial_comment: completeBody.get("initial_comment"),
    }).toEqual({
      files: [{ id: "F1", title: "Banner" }],
      channel_id: "C1",
      thread_ts: "100.0",
      initial_comment: "done",
    })
  })

  it("preserves raw Slack thread reply counts from conversations.history", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            messages: [
              {
                user: "U1",
                text: "root",
                ts: "100.0",
                reply_count: 2,
              },
            ],
          }),
          { status: 200 },
        ),
    )
    const client = new LeucoFetchSlackWebClient({
      botToken: "xoxb-test",
      fetchFn: fetchMock,
    })

    const history = await client.apiCall("conversations.history", {
      channel: "D1",
      oldest: null,
      inclusive: null,
      limit: 50,
    })

    expect(history).toEqual({
      ok: true,
      messages: [{ user: "U1", text: "root", ts: "100.0", reply_count: 2 }],
    })
  })

  it.each([
    [
      "files.getUploadURLExternal",
      { filename: "report.pdf", length: 123 },
      { filename: "report.pdf", length: "123" },
    ],
    [
      "files.completeUploadExternal",
      { files: [{ id: "F1", title: "report" }], channel_id: "C1" },
      { files: JSON.stringify([{ id: "F1", title: "report" }]), channel_id: "C1" },
    ],
  ])("posts %s as form-encoded data through apiCall", async (method, body, expected) => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    await client.apiCall(method, body)

    const [url, init] = onlyFetchCall(fetchMock)
    expect(url).toBe(`https://slack.com/api/${method}`)
    expectFormBody(init, expected)
  })

  it("retries once after a 429 honoring retry-after", async () => {
    const responses = [
      new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ]
    const fetchMock = vi.fn(async () => {
      const next = responses.shift()
      if (next === undefined) throw new Error("unexpected extra fetch")
      return next
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxb-test" })
    await client.apiCall("chat.postMessage", { channel: "C1", text: "hi" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("gives up when the single retry is rate limited again", async () => {
    const fetchMock = vi.fn(
      async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxb-test" })

    await expect(client.apiCall("chat.postMessage", { channel: "C1", text: "hi" })).rejects.toThrow(
      "http 429",
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("aborts a Slack API request at the configured deadline", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })
      },
    )
    const client = new LeucoFetchSlackWebClient({
      botToken: "xoxb-test",
      requestTimeoutMs: 5,
      fetchFn: fetchMock,
    })

    await expect(client.authTest()).rejects.toThrow("slack auth.test timed out after 5ms")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the deadline active while reading the response body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
        },
      })
      return new Response(body, { status: 200 })
    })
    const client = new LeucoFetchSlackWebClient({
      botToken: "xoxb-test",
      requestTimeoutMs: 5,
      fetchFn: fetchMock,
    })

    await expect(client.authTest()).rejects.toThrow("slack auth.test timed out after 5ms")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("rejects an oversized response before parsing it", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(3 * 1024 * 1024) },
        }),
    ) as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxb-test" })

    await expect(client.apiCall("conversations.history", {})).rejects.toThrow(
      "retry with a smaller limit, cursor, or filter",
    )
  })

  it("stops reading a chunked response after the byte cap", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("x".repeat(3 * 1024 * 1024), { status: 200 }),
    ) as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxb-test" })

    await expect(client.apiCall("conversations.history", {})).rejects.toThrow("response exceeded")
  })
})

const onlyFetchCall = (
  fetchMock: ReturnType<typeof vi.fn>,
): [string | URL | Request, RequestInit] => {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const call = fetchMock.mock.calls[0]
  if (call === undefined) throw new Error("expected fetch to be called")
  const [url, init] = call
  if (init === undefined) throw new Error("expected fetch init")
  return [url as string | URL | Request, init as RequestInit]
}

const expectFormBody = (init: RequestInit, expected: Record<string, string>): void => {
  expect(init).toMatchObject({
    method: "POST",
    headers: {
      Authorization: "Bearer xoxp-test",
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
  })
  const params = new URLSearchParams(String(init.body))
  for (const [key, value] of Object.entries(expected)) {
    expect(params.get(key)).toBe(value)
  }
}

it("keeps stored bearer authentication and literal body keys without mutating caller data", async () => {
  const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
  )
  const client = new LeucoFetchSlackWebClient({
    botToken: "synthetic-stored-token",
    fetchFn: fetchMock,
  })
  const body: Record<string, unknown> = JSON.parse(
    '{"token":"caller-override","__proto__":{"literal":true},"constructor":"value","channel":"C1"}',
  )
  const original = JSON.stringify(body)
  await client.apiCall("chat.postMessage", body)
  const request = fetchMock.mock.calls[0]?.[1]
  expect(new Headers(request?.headers).get("authorization")).toBe("Bearer synthetic-stored-token")
  const forwarded = JSON.parse(String(request?.body))
  expect(forwarded).toEqual(
    JSON.parse('{"__proto__":{"literal":true},"constructor":"value","channel":"C1"}'),
  )
  expect(Object.hasOwn(forwarded, "token")).toBe(false)
  expect(Object.hasOwn(forwarded, "__proto__")).toBe(true)
  expect(JSON.stringify(body)).toBe(original)
})
