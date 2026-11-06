import { afterEach, describe, expect, it, vi } from "vitest"
import { discordCall } from "@/actions/discord/discord-call"
import { executeDiscordCommand } from "@/actions/discord/execute-discord-command"

vi.mock("@/actions/discord/discord-call", () => ({
  discordCall: vi.fn(async () => ({ id: "1" })),
}))
afterEach(() => {
  vi.clearAllMocks()
})

describe("executeDiscordCommand", () => {
  it("passes the caller signal to the Discord REST call", async () => {
    const controller = new AbortController()
    const parsed = {
      words: ["discord", "call", "POST", "/channels/1/messages"],
      flags: { body: '{"content":"hello"}' },
    }
    expect(
      await executeDiscordCommand({ parsed, botToken: "dummy-token", signal: controller.signal }),
    ).toEqual({ id: "1" })
    expect(vi.mocked(discordCall).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      endpoint: "/channels/1/messages",
      body: { content: "hello" },
    })
    expect(vi.mocked(discordCall).mock.calls[0]?.[0].signal).toBe(controller.signal)
  })
})
