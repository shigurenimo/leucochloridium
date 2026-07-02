import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoFetchSlackWebClient } from "@/channels/slack/leuco-fetch-slack-web-client"

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
          }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    const result = await client.conversationsList({ types: "im", limit: 200 })

    const [url, init] = onlyFetchCall(fetchMock)
    expect(url).toBe("https://slack.com/api/conversations.list")
    expectFormBody(init, {
      types: "im",
      limit: "200",
    })
    expect(result.channels).toEqual([{ id: "D1", isIm: true }])
  })

  it("posts conversations.replies as form-encoded data through apiCall", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new LeucoFetchSlackWebClient({ botToken: "xoxp-test" })
    await client.apiCall("conversations.replies", {
      channel: "D1",
      ts: "100.0",
      limit: 100,
    })

    const [url, init] = onlyFetchCall(fetchMock)
    expect(url).toBe("https://slack.com/api/conversations.replies")
    expectFormBody(init, {
      channel: "D1",
      ts: "100.0",
      limit: "100",
    })
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
