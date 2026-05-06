import { describe, expect, it } from "vitest"
import { LeucoSlackEventProcessor } from "@/channels/slack/slack-event-processor"

const baseMention = (overrides: Record<string, unknown> = {}) => ({
  channel: "C1",
  user: "U_USER",
  text: "<@UBOT> hello",
  ts: "1.0",
  ...overrides,
})

const baseMessage = (overrides: Record<string, unknown> = {}) => ({
  channel: "C1",
  user: "U_USER",
  text: "<@UBOT> hi",
  ts: "1.0",
  ...overrides,
})

const baseReaction = (overrides: Record<string, unknown> = {}) => ({
  type: "reaction_added",
  user: "U_USER",
  reaction: "thumbsup",
  item: { type: "message", channel: "C1", ts: "1.0" },
  item_user: "UBOT",
  event_ts: "2.0",
  ...overrides,
})

const expectMessage = (
  result: ReturnType<LeucoSlackEventProcessor["processMessage"]>,
): Extract<typeof result, { skip: false }>["event"] & { kind: "message" } => {
  if (result.skip) throw new Error(`expected emit, got skip: ${result.reason}`)
  if (result.event.kind !== "message") throw new Error(`expected message event, got ${result.event.kind}`)
  return result.event
}

const expectReaction = (
  result: ReturnType<LeucoSlackEventProcessor["processReaction"]>,
) => {
  if (result.skip) throw new Error(`expected emit, got skip: ${result.reason}`)
  if (result.event.kind === "message") throw new Error("expected reaction event, got message")
  return result.event
}

describe("LeucoSlackEventProcessor.processAppMention", () => {
  it("emits a normalized message event with mentioned=true", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const event = expectMessage(proc.processAppMention(baseMention()))
    expect(event.source).toBe("app_mention")
    expect(event.text).toBe("hello")
    expect(event.rawText).toBe("<@UBOT> hello")
    expect(event.mentioned).toBe(true)
    expect(event.threadTs).toBe("1.0")
    expect(event.isThreadRoot).toBe(true)
  })

  it("uses thread_ts when present", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const event = expectMessage(proc.processAppMention(baseMention({ thread_ts: "0.9" })))
    expect(event.threadTs).toBe("0.9")
    expect(event.isThreadRoot).toBe(false)
  })

  it("skips events that fail schema validation", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const result = proc.processAppMention({})
    expect(result.skip).toBe(true)
  })

  it("dedups duplicate ts values", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const first = proc.processAppMention(baseMention({ ts: "42" }))
    const second = proc.processAppMention(baseMention({ ts: "42" }))
    expect(first.skip).toBe(false)
    expect(second.skip).toBe(true)
    if (second.skip) expect(second.reason).toContain("dedup")
  })
})

describe("LeucoSlackEventProcessor.processMessage", () => {
  it("emits even when the bot is not mentioned (forwarding model)", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const event = expectMessage(proc.processMessage(baseMessage({ text: "hello channel" })))
    expect(event.mentioned).toBe(false)
    expect(event.text).toBe("hello channel")
  })

  it("emits with mentioned=true when the bot was mentioned", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const event = expectMessage(proc.processMessage(baseMessage()))
    expect(event.source).toBe("message")
    expect(event.mentioned).toBe(true)
    expect(event.text).toBe("hi")
  })

  it("skips bot self-messages", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const result = proc.processMessage(baseMessage({ user: "UBOT" }))
    expect(result.skip).toBe(true)
    if (result.skip) expect(result.reason).toContain("self")
  })

  it("skips bot_id messages", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const result = proc.processMessage(baseMessage({ bot_id: "B1" }))
    expect(result.skip).toBe(true)
  })

  it("skips messages with subtype", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const result = proc.processMessage(baseMessage({ subtype: "channel_join" }))
    expect(result.skip).toBe(true)
  })

  it("skips when botUserId is unknown", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: null })
    const result = proc.processMessage(baseMessage())
    expect(result.skip).toBe(true)
  })
})

describe("LeucoSlackEventProcessor.processReaction", () => {
  it("emits a reaction_added event", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const event = expectReaction(proc.processReaction(baseReaction()))
    expect(event.kind).toBe("reaction_added")
    expect(event.emoji).toBe("thumbsup")
    expect(event.targetTs).toBe("1.0")
    expect(event.targetUser).toBe("UBOT")
  })

  it("emits a reaction_removed event", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const event = expectReaction(proc.processReaction(baseReaction({ type: "reaction_removed" })))
    expect(event.kind).toBe("reaction_removed")
  })

  it("skips reactions made by the bot itself", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const result = proc.processReaction(baseReaction({ user: "UBOT" }))
    expect(result.skip).toBe(true)
    if (result.skip) expect(result.reason).toContain("self reaction")
  })

  it("dedups identical reaction events", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT" })
    const first = proc.processReaction(baseReaction())
    const second = proc.processReaction(baseReaction())
    expect(first.skip).toBe(false)
    expect(second.skip).toBe(true)
  })
})

describe("LeucoSlackEventProcessor dedup capacity", () => {
  it("evicts the oldest key when over capacity", () => {
    const proc = new LeucoSlackEventProcessor({ botUserId: "UBOT", dedupCapacity: 2 })
    proc.processAppMention(baseMention({ ts: "1" }))
    proc.processAppMention(baseMention({ ts: "2" }))
    proc.processAppMention(baseMention({ ts: "3" }))
    // ts=1 evicted, replay no longer dedups
    const replay = proc.processAppMention(baseMention({ ts: "1" }))
    expect(replay.skip).toBe(false)
  })
})
