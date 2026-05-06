import { describe, expect, it, vi } from "vitest"
import { LeucoSlackAdapter } from "@/channels/slack/slack-adapter"
import type { WebClientPort } from "@/channels/slack/web-client-port"

const fakeClient = (overrides: Partial<WebClientPort> = {}): WebClientPort => ({
  chat: { postMessage: vi.fn(async () => undefined) },
  reactions: {
    add: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
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
