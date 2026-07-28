import { describe, expect, it } from "vitest"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoSlackAdapter } from "@/connectors/slack/slack-adapter"

describe("LeucoSlackAdapter.postReply", () => {
  it("forwards channel/threadTs/text", async () => {
    const client = new LeucoMemorySlackWebClient()
    const adapter = new LeucoSlackAdapter({ client })

    await adapter.postReply({ channel: "C1", threadTs: "1.0", text: "hi" })

    expect(client.calls.chatPostMessage).toEqual([{ channel: "C1", threadTs: "1.0", text: "hi" }])
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
