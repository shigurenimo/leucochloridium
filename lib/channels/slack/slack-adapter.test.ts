import { describe, expect, it, vi } from "vitest"
import { LeucoSlackAdapter } from "@/channels/slack/slack-adapter"
import type { WebClientPort } from "@/channels/slack/web-client-port"

const fakeClient = (overrides: Partial<WebClientPort> = {}): WebClientPort => ({
  chat: { postMessage: vi.fn(async () => undefined) },
  reactions: {
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  conversations: {
    info: vi.fn(async () => undefined),
    replies: vi.fn(async () => ({ messages: [] })),
  },
  auth: { test: vi.fn(async () => undefined) },
  ...overrides,
})

describe("LeucoSlackAdapter.postReply", () => {
  it("forwards channel/thread_ts/text", async () => {
    const client = fakeClient()
    const adapter = new LeucoSlackAdapter({ client })
    await adapter.postReply({ channel: "C1", threadTs: "1.0", text: "hi" })
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1.0",
      text: "hi",
    })
  })
})

describe("LeucoSlackAdapter.canReadChannel", () => {
  it("returns true when conversations.info succeeds", async () => {
    const client = fakeClient()
    const adapter = new LeucoSlackAdapter({ client })
    await expect(adapter.canReadChannel("D1")).resolves.toBe(true)
    expect(client.conversations.info).toHaveBeenCalledWith({ channel: "D1" })
  })

  it("returns false for a public channel the bot is not a member of", async () => {
    const client = fakeClient({
      conversations: {
        info: vi.fn(async () => ({ channel: { is_member: false } })),
        replies: vi.fn(async () => ({ messages: [] })),
      },
    })
    const adapter = new LeucoSlackAdapter({ client })
    await expect(adapter.canReadChannel("C1")).resolves.toBe(false)
  })

  it("returns true for a public channel the bot is a member of", async () => {
    const client = fakeClient({
      conversations: {
        info: vi.fn(async () => ({ channel: { is_member: true } })),
        replies: vi.fn(async () => ({ messages: [] })),
      },
    })
    const adapter = new LeucoSlackAdapter({ client })
    await expect(adapter.canReadChannel("C1")).resolves.toBe(true)
  })

  it("returns false when conversations.info fails", async () => {
    const client = fakeClient({
      conversations: {
        info: vi.fn(async () => Promise.reject(new Error("channel_not_found"))),
        replies: vi.fn(async () => ({ messages: [] })),
      },
    })
    const adapter = new LeucoSlackAdapter({ client })
    await expect(adapter.canReadChannel("D1")).resolves.toBe(false)
  })
})

describe("LeucoSlackAdapter.hasBotReplyAfter", () => {
  it("detects a later reply from the bot user", async () => {
    const client = fakeClient({
      conversations: {
        info: vi.fn(async () => undefined),
        replies: vi.fn(async () => ({
          messages: [
            { user: "U_OTHER", text: "hi" },
            { user: "U_BOT", text: "working" },
          ],
        })),
      },
    })
    const adapter = new LeucoSlackAdapter({ client })
    await expect(adapter.hasBotReplyAfter("C1", "1.0", "1.0", "U_BOT")).resolves.toBe(true)
    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1.0",
      oldest: "1.0",
      inclusive: false,
      limit: 100,
    })
  })

  it("ignores configured status texts", async () => {
    const client = fakeClient({
      conversations: {
        info: vi.fn(async () => undefined),
        replies: vi.fn(async () => ({
          messages: [{ user: "U_BOT", text: "見てます。少し待ってください。" }],
        })),
      },
    })
    const adapter = new LeucoSlackAdapter({ client })
    await expect(
      adapter.hasBotReplyAfter("C1", "1.0", "1.0", "U_BOT", {
        ignoredTexts: ["見てます。少し待ってください。"],
      }),
    ).resolves.toBe(false)
  })
})

describe("LeucoSlackAdapter.addReaction / removeReaction", () => {
  it("calls the underlying client with the right shape", async () => {
    const client = fakeClient()
    const adapter = new LeucoSlackAdapter({ client })
    await adapter.addReaction("C1", "1.0", "thumbsup")
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1.0",
      name: "thumbsup",
    })

    await adapter.removeReaction("C1", "1.0", "thumbsup")
    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C1",
      timestamp: "1.0",
      name: "thumbsup",
    })
  })

  it("swallows reaction errors silently", async () => {
    const client = fakeClient({
      reactions: {
        add: vi.fn(async () => Promise.reject(new Error("already_reacted"))),
        remove: vi.fn(async () => Promise.reject(new Error("no_reaction"))),
      },
    })
    const adapter = new LeucoSlackAdapter({ client })
    await expect(adapter.addReaction("C1", "1.0", "x")).resolves.toBeUndefined()
    await expect(adapter.removeReaction("C1", "1.0", "x")).resolves.toBeUndefined()
  })
})
