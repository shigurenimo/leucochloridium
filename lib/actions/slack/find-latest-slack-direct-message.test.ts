import { describe, expect, it } from "vitest"
import { findLatestSlackDirectMessage } from "@/actions/slack/find-latest-slack-direct-message"
import { LeucoMemorySlackWebClient } from "@/channels/slack/leuco-memory-slack-web-client"
import type { SlackHistoryMessage } from "@/channels/slack/leuco-slack-web-client"

const message = (ts: string, props: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage => ({
  user: "U1",
  text: "hello",
  ts,
  threadTs: null,
  subtype: null,
  botId: null,
  ...props,
})

describe("findLatestSlackDirectMessage", () => {
  it("paginates DMs and returns the history containing the newest human message", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsList: ({ cursor }) =>
        cursor === null
          ? {
              channels: [
                { id: "D1", isIm: true },
                { id: "C1", isIm: false },
              ],
              nextCursor: "page-2",
            }
          : {
              channels: [
                { id: "D1", isIm: true },
                { id: "D2", isIm: true },
              ],
              nextCursor: null,
            },
      conversationsHistory: ({ channel }) =>
        channel === "D1"
          ? {
              messages: [
                message("100.0"),
                message("300.0", { user: "UBOT" }),
                message("400.0", { botId: "B1" }),
              ],
            }
          : { messages: [message("200.0")] },
    })

    const result = await findLatestSlackDirectMessage({
      client,
      botUserId: "UBOT",
      historyLimit: 50,
    })

    expect(result).toMatchObject({
      conversationId: "D2",
      message: { ts: "200.0", user: "U1" },
    })
    expect(client.calls.conversationsList).toEqual([
      { types: "im", limit: 200, cursor: null },
      { types: "im", limit: 200, cursor: "page-2" },
    ])
    expect(client.calls.conversationsHistory).toEqual([
      { channel: "D1", oldest: null, inclusive: null, limit: 50 },
      { channel: "D2", oldest: null, inclusive: null, limit: 50 },
    ])
  })

  it("returns null when no DM contains a non-bot message", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsList: {
        channels: [{ id: "D1", isIm: true }],
        nextCursor: null,
      },
      conversationsHistory: {
        messages: [
          message("100.0", { user: "UBOT" }),
          message("101.0", { subtype: "channel_join" }),
        ],
      },
    })

    const result = await findLatestSlackDirectMessage({
      client,
      botUserId: "UBOT",
      historyLimit: 25,
    })

    expect(result).toBeNull()
  })

  it("stops when Slack repeats a pagination cursor", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsList: { channels: [], nextCursor: "same" },
    })

    const result = await findLatestSlackDirectMessage({
      client,
      botUserId: null,
      historyLimit: 50,
    })

    expect(result).toBeNull()
    expect(client.calls.conversationsList).toHaveLength(2)
  })
})
