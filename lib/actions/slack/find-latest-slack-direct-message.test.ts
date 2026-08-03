import { describe, expect, it } from "vitest"
import { findLatestSlackDirectMessage } from "@/actions/slack/find-latest-slack-direct-message"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import type { SlackHistoryMessage } from "@/connectors/slack/leuco-slack-web-client"

const message = (ts: string, props: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage => ({
  user: "U1",
  text: "hello",
  ts,
  threadTs: null,
  replyCount: null,
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

  it("selects a human thread reply newer than every top-level DM", async () => {
    const root = message("100.0", { replyCount: 1 })
    const reply = message("300.0", { threadTs: "100.0" })
    const client = new LeucoMemorySlackWebClient({
      conversationsList: {
        channels: [
          { id: "D1", isIm: true },
          { id: "D2", isIm: true },
        ],
        nextCursor: null,
      },
      conversationsHistory: ({ channel }) => ({
        messages: channel === "D1" ? [root] : [message("200.0")],
      }),
      conversationsReplies: { messages: [root, reply] },
    })

    const result = await findLatestSlackDirectMessage({
      client,
      botUserId: "UBOT",
      historyLimit: 50,
    })

    expect(result).toMatchObject({
      conversationId: "D1",
      message: { ts: "300.0", threadTs: "100.0" },
    })
    expect(result?.messages).toEqual([root, reply])
    expect(client.calls.conversationsReplies).toEqual([
      {
        channel: "D1",
        ts: "100.0",
        oldest: null,
        inclusive: null,
        limit: 50,
        cursor: null,
      },
    ])
  })

  it("paginates thread replies before selecting the latest human message", async () => {
    const root = message("100.0", { replyCount: 2 })
    const client = new LeucoMemorySlackWebClient({
      conversationsList: {
        channels: [{ id: "D1", isIm: true }],
        nextCursor: null,
      },
      conversationsHistory: { messages: [root] },
      conversationsReplies: (args) =>
        args.cursor === null
          ? {
              messages: [root, message("200.0", { threadTs: "100.0" })],
              nextCursor: "page-2",
            }
          : {
              messages: [message("300.0", { threadTs: "100.0" })],
              nextCursor: null,
            },
    })

    const result = await findLatestSlackDirectMessage({
      client,
      botUserId: "UBOT",
      historyLimit: 2,
    })

    expect(result).toMatchObject({
      conversationId: "D1",
      message: { ts: "300.0", threadTs: "100.0" },
    })
    expect(client.calls.conversationsReplies.map((call) => call.cursor)).toEqual([null, "page-2"])
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
