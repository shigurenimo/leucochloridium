import { describe, expect, it, vi } from "vitest"
import { discordCall } from "@/actions/discord/discord-call"

const botToken = "dummy-token"
describe("Discord REST boundary", () => {
  it("sends authentication only to the fixed v10 host and returns JSON", async () => {
    const fetchFn = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ id: "123" }),
    )
    expect(
      await discordCall({
        botToken,
        method: "POST",
        endpoint: "/channels/123/messages",
        body: { content: "hello" },
        fetchFn,
      }),
    ).toEqual({ id: "123" })
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://discord.com/api/v10/channels/123/messages")
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bot dummy-token" },
      body: '{"content":"hello"}',
    })
  })
  it.each([
    "https://evil.test",
    "//evil.test",
    "/../evil",
    "/%2e%2e/evil",
    "/%5cevil",
    "/channels/1#fragment",
  ])("rejects unsafe endpoints %s before network access", async (endpoint) => {
    const fetchFn =
      vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
    await expect(discordCall({ botToken, method: "GET", endpoint, fetchFn })).rejects.toThrow()
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it("supports encoded emoji and empty success bodies", async () => {
    const fetchFn = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    )
    expect(
      await discordCall({
        botToken,
        method: "PUT",
        endpoint: "/channels/1/messages/2/reactions/%F0%9F%91%80/@me",
        fetchFn,
      }),
    ).toEqual({ ok: true })
  })
  it("never retries a rate-limited write or exposes the response body", async () => {
    const fetchFn = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async () => new Response("private upstream data", { status: 429 }),
    )
    await expect(
      discordCall({
        botToken,
        method: "POST",
        endpoint: "/channels/1/messages",
        body: {},
        fetchFn,
      }),
    ).rejects.toThrow("HTTP 429")
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
