import { describe, expect, it } from "vitest"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoSlackAdapter } from "@/connectors/slack/slack-adapter"

describe("LeucoSlackAdapter.addReaction / removeReaction", () => {
  it("calls the underlying client with the right shape", async () => {
    const client = new LeucoMemorySlackWebClient()
    const adapter = new LeucoSlackAdapter({ client })

    expect(await adapter.addReaction("C1", "1.0", "thumbsup")).toBeNull()
    expect(await adapter.removeReaction("C1", "1.0", "thumbsup")).toBeNull()

    expect(client.calls.reactionsAdd).toEqual([
      { channel: "C1", timestamp: "1.0", name: "thumbsup" },
    ])
    expect(client.calls.reactionsRemove).toEqual([
      { channel: "C1", timestamp: "1.0", name: "thumbsup" },
    ])
  })

  it("ignores idempotent reaction misses", async () => {
    const client = new LeucoMemorySlackWebClient({
      reactionsAdd: () => {
        throw new Error("already_reacted")
      },
      reactionsRemove: () => {
        throw new Error("no_reaction")
      },
    })
    const adapter = new LeucoSlackAdapter({ client })

    await expect(adapter.addReaction("C1", "1.0", "x")).resolves.toBeNull()
    await expect(adapter.removeReaction("C1", "1.0", "x")).resolves.toBeNull()
  })

  it("returns other reaction failures without throwing", async () => {
    const scope = Object.assign(new Error("missing_scope"), { code: "slack_webapi_platform_error" })
    const client = new LeucoMemorySlackWebClient({
      reactionsAdd: () => {
        throw scope
      },
      reactionsRemove: () => Promise.reject("invalid_auth"),
    })
    const adapter = new LeucoSlackAdapter({ client })

    expect(await adapter.addReaction("C1", "1.0", "x")).toBe(scope)
    const removed = await adapter.removeReaction("C1", "1.0", "x")
    expect(removed).toBeInstanceOf(Error)
    expect(removed?.message).toBe("invalid_auth")
  })
})
