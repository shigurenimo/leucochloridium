import { describe, expect, it } from "vitest"
import { LeucoMemorySlackWebClient } from "@/channels/slack/leuco-memory-slack-web-client"
import { LeucoSlackXoxpPoller } from "@/channels/slack/leuco-slack-xoxp-poller"

describe("LeucoSlackXoxpPoller", () => {
  it("starts and stops without throwing (regression: Object.freeze on mutable state)", () => {
    const poller = new LeucoSlackXoxpPoller({
      client: new LeucoMemorySlackWebClient(),
      botUserId: "U1",
      dispatchMessage: async () => {},
      rememberActiveThread: () => {},
      onLog: () => {},
    })

    expect(() => poller.start()).not.toThrow()
    expect(() => poller.stop()).not.toThrow()
  })

  it("runs the DM poll once at start and dispatches new messages", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsList: { channels: [{ id: "D1", isIm: true }] },
      conversationsHistory: {
        messages: [
          {
            user: "U2",
            text: "hi",
            ts: "100.0",
            threadTs: null,
            subtype: null,
            botId: null,
          },
        ],
      },
    })
    const dispatched: Array<{ channel: string; ts: string }> = []
    const poller = new LeucoSlackXoxpPoller({
      client,
      botUserId: "U1",
      dispatchMessage: async (raw) => {
        dispatched.push({ channel: raw.channel, ts: raw.ts })
      },
      rememberActiveThread: () => {},
      onLog: () => {},
    })

    poller.start()
    await waitFor(() => dispatched.length > 0)
    poller.stop()

    expect(dispatched).toEqual([{ channel: "D1", ts: "100.0" }])
  })
})

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(predicate()).toBe(true)
}
