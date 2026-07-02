import { describe, expect, it } from "vitest"
import { LeucoMemorySlackWebClient } from "@/channels/slack/leuco-memory-slack-web-client"
import { LeucoSlackAdapter } from "@/channels/slack/slack-adapter"

describe("LeucoSlackAdapter.postReply", () => {
  it("forwards channel/threadTs/text", async () => {
    const client = new LeucoMemorySlackWebClient()
    const adapter = new LeucoSlackAdapter({ client })

    await adapter.postReply({ channel: "C1", threadTs: "1.0", text: "hi" })

    expect(client.calls.chatPostMessage).toEqual([{ channel: "C1", threadTs: "1.0", text: "hi" }])
  })
})

describe("LeucoSlackAdapter.canReadChannel", () => {
  it("returns true when conversations.info succeeds for a DM channel", async () => {
    const client = new LeucoMemorySlackWebClient()
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("D1")).resolves.toBe(true)

    expect(client.calls.conversationsInfo).toEqual([{ channel: "D1" }])
  })

  it("returns false for a public channel the bot is not a member of", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: { isMember: false },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("C1")).resolves.toBe(false)
  })

  it("returns true for a public channel the bot is a member of", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: { isMember: true },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)
  })

  it("returns false when conversations.info fails", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: () => {
        throw new Error("channel_not_found")
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("D1")).resolves.toBe(false)
  })

  it("caches a positive result and skips repeat conversations.info calls", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: { isMember: true },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)
    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)

    expect(client.calls.conversationsInfo).toHaveLength(1)
  })

  it("caches a permanent denial", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: () => {
        throw new Error("slack conversations.info: channel_not_found")
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("C1")).resolves.toBe(false)
    await expect(adapter.canReadChannel("C1")).resolves.toBe(false)

    expect(client.calls.conversationsInfo).toHaveLength(1)
  })

  it("does not cache transient conversations.info failures", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: () => {
        throw new Error("slack conversations.info http 503 Service Unavailable")
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)
    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)

    expect(client.calls.conversationsInfo).toHaveLength(2)
  })

  it("re-checks the channel once the cache TTL expires", async () => {
    const clock = { nowMs: 0 }
    const client = new LeucoMemorySlackWebClient({
      conversationsInfo: { isMember: true },
    })
    const adapter = new LeucoSlackAdapter({ client, now: () => clock.nowMs })

    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)
    clock.nowMs = 5 * 60 * 1000 + 1
    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)

    expect(client.calls.conversationsInfo).toHaveLength(2)
  })
})

describe("LeucoSlackAdapter.hasBotReplyAfter", () => {
  it("detects a later reply from the bot user", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsReplies: {
        messages: [
          { user: "U_OTHER", text: "hi", ts: "1.1", threadTs: null, subtype: null, botId: null },
          { user: "U_BOT", text: "working", ts: "1.2", threadTs: null, subtype: null, botId: null },
        ],
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.hasBotReplyAfter("C1", "1.0", "1.0", "U_BOT")).resolves.toBe(true)
    expect(client.calls.conversationsReplies).toEqual([
      { channel: "C1", ts: "1.0", oldest: "1.0", inclusive: false, limit: 100 },
    ])
  })

  it("ignores configured status texts", async () => {
    const client = new LeucoMemorySlackWebClient({
      conversationsReplies: {
        messages: [
          {
            user: "U_BOT",
            text: "status update",
            ts: "1.1",
            threadTs: null,
            subtype: null,
            botId: null,
          },
        ],
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(
      adapter.hasBotReplyAfter("C1", "1.0", "1.0", "U_BOT", {
        ignoredTexts: ["status update"],
      }),
    ).resolves.toBe(false)
  })
})

describe("LeucoSlackAdapter.addReaction / removeReaction", () => {
  it("calls the underlying client with the right shape", async () => {
    const client = new LeucoMemorySlackWebClient()
    const adapter = new LeucoSlackAdapter({ client })

    await adapter.addReaction("C1", "1.0", "thumbsup")
    await adapter.removeReaction("C1", "1.0", "thumbsup")

    expect(client.calls.reactionsAdd).toEqual([
      { channel: "C1", timestamp: "1.0", name: "thumbsup" },
    ])
    expect(client.calls.reactionsRemove).toEqual([
      { channel: "C1", timestamp: "1.0", name: "thumbsup" },
    ])
  })

  it("swallows reaction errors silently", async () => {
    const client = new LeucoMemorySlackWebClient({
      reactionsAdd: () => {
        throw new Error("already_reacted")
      },
      reactionsRemove: () => {
        throw new Error("no_reaction")
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.addReaction("C1", "1.0", "x")).resolves.toBeUndefined()
    await expect(adapter.removeReaction("C1", "1.0", "x")).resolves.toBeUndefined()
  })
})
