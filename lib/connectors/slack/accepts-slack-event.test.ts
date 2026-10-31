import { describe, expect, it } from "vitest"
import { slackReceptionSchema } from "@/config/config-schema"
import { acceptsSlackEvent } from "@/connectors/slack/accepts-slack-event"
import type { SlackMessageEvent } from "@/connectors/slack/slack-types"

const message: SlackMessageEvent = {
  kind: "message",
  channel: "C1",
  user: "U1",
  rawText: "hello",
  text: "hello",
  threadTs: "1",
  ts: "2",
  isThreadRoot: false,
  mentioned: false,
  source: "message",
}

describe("Slack reception rules", () => {
  it.each([
    [{}, {}, false, false],
    [{}, { channel: "D1", mentioned: true }, false, true],
    [{ directMessages: false }, { channel: "D1", mentioned: true }, false, false],
    [{}, { mentioned: true }, false, true],
    [{ mentions: false }, { mentioned: true }, false, false],
    [{}, {}, true, true],
    [{ participatingThreads: false }, {}, true, false],
    [{ channelMessages: true }, {}, false, true],
    [{ allowedChannels: [] }, { mentioned: true }, false, false],
    [{ allowedChannels: ["C1"] }, { mentioned: true }, false, true],
    [{ allowedChannels: ["C1"], deniedChannels: ["C1"] }, { mentioned: true }, false, false],
    [{ allowedUsers: ["U2"] }, { mentioned: true }, false, false],
    [{ deniedUsers: ["U1"] }, { channel: "D1" }, false, false],
  ])("applies rules %j to %j", (rules, overrides, participating, expected) => {
    expect(
      acceptsSlackEvent({
        event: { ...message, ...overrides },
        reception: slackReceptionSchema.parse(rules),
        participating,
      }),
    ).toBe(expected)
  })

  it("separates reaction additions from removals", () => {
    const event = {
      kind: "reaction_removed",
      channel: "C1",
      user: "U1",
      emoji: "eyes",
      targetTs: "1",
      targetUser: null,
    } satisfies Parameters<typeof acceptsSlackEvent>[0]["event"]
    expect(
      acceptsSlackEvent({
        event,
        reception: slackReceptionSchema.parse({ reactionAdded: ["eyes"] }),
        participating: false,
      }),
    ).toBe(false)
    expect(
      acceptsSlackEvent({
        event,
        reception: slackReceptionSchema.parse({ reactionRemoved: ["eyes"] }),
        participating: false,
      }),
    ).toBe(true)
  })

  it("rejects misspelled settings and wrong value types", () => {
    expect(slackReceptionSchema.safeParse({ mention: true }).success).toBe(false)
    expect(slackReceptionSchema.safeParse({ allowedChannels: "C1" }).success).toBe(false)
  })
})
