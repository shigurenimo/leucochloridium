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
})
