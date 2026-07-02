import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"

describe("fetchSlackFile", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("returns the response directly when no redirect happens", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response("filebytes", { status: 200 }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t")

    expect(await response.text()).toBe("filebytes")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual")
  })

  it("follows a redirect to another slack host and re-sends the token", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      if (String(url).includes("edge.slack.com")) {
        return new Response("filebytes", { status: 200 })
      }
      return new Response(null, {
        status: 302,
        headers: { Location: "https://edge.slack.com/blob" },
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const response = await fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t")

    expect(await response.text()).toBe("filebytes")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.redirect).toBe("manual")
      expect(call[1]?.headers).toMatchObject({ Authorization: "Bearer xoxb-t" })
    }
  })

  it("resolves a relative location against the current url", async () => {
    const seenUrls: string[] = []
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      seenUrls.push(String(url))
      if (seenUrls.length === 1) {
        return new Response(null, { status: 302, headers: { Location: "/moved/blob" } })
      }
      return new Response("filebytes", { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t")

    expect(seenUrls[1]).toBe("https://files.slack.com/moved/blob")
  })

  it("refuses a redirect to a non-slack host", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example.com/steal" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t"),
    ).rejects.toThrow("non-slack host")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws after more than 3 redirect hops", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://files.slack.com/again" },
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t"),
    ).rejects.toThrow("too many redirects")
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("throws on a redirect without a location header", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchSlackFile("https://files.slack.com/files-pri/T1-F1/x", "xoxb-t"),
    ).rejects.toThrow("without location header")
  })
})
