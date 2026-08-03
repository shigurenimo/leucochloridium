import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

describe("LeucoFetchSlackWebClient", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
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
    const result = await client.searchMessages({
      query: "<@UBOT>",
      sort: "timestamp",
      sortDir: "desc",
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
    expect(result.matches).toEqual([
      {
        channelId: "C1",
        user: "U1",
        text: "<@UBOT> hi",
        ts: "100.0",
        permalink: "https://example.slack.com/archives/C1/p100",
      },
    ])
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
    const result = await client.conversationsList({
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
    expect(result.channels).toEqual([{ id: "D1", isIm: true }])
    expect(result.nextCursor).toBe("page-2")
  })

  it("posts and normalizes cursor pagination for conversations.replies", async () => {
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
    const replies = await client.conversationsReplies({
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
    expect(replies.nextCursor).toBe("page-2")
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
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
    expect(String(completeCall[0])).toBe("https://slack.com/api/files.completeUploadExternal")
    expect(JSON.parse(String(completeCall[1]?.body))).toEqual({
      files: [{ id: "F1", title: "Banner" }],
      channel_id: "C1",
      thread_ts: "100.0",
      initial_comment: "done",
    })
  })

  it("normalizes Slack thread reply counts from conversations.history", async () => {
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

    const history = await client.conversationsHistory({
      channel: "D1",
      oldest: null,
      inclusive: null,
      limit: 50,
    })

    expect(history.messages).toEqual([
      {
        user: "U1",
        text: "root",
        ts: "100.0",
        threadTs: null,
        replyCount: 2,
        subtype: null,
        botId: null,
      },
    ])
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
    await client.chatPostMessage({ channel: "C1", threadTs: null, text: "hi" })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("gives up when the single retry is rate limited again", async () => {
    const fetchMock = vi.fn(
      async () => new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxb-test" })

    await expect(
      client.chatPostMessage({ channel: "C1", threadTs: null, text: "hi" }),
    ).rejects.toThrow("http 429")
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
