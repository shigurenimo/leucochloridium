import { describe, expect, it } from "vitest"
import { receptionRulesSchema } from "@/config/config-schema"
import { acceptsReception } from "@/connectors/accepts-reception"

const target = { channel: "C1", user: "U1" }

describe("shared reception rules", () => {
  it.each([
    ["dm", {}, true],
    ["dm", { directMessages: false }, false],
    ["mention", {}, true],
    ["mention", { mentions: false }, false],
    ["thread", {}, true],
    ["thread", { participatingThreads: false }, false],
    ["message", {}, false],
    ["message", { channelMessages: true }, true],
  ] satisfies Array<["dm" | "mention" | "thread" | "message", Record<string, boolean>, boolean]>)(
    "maps %s to its flag with rules %j",
    (kind, rules, expected) => {
      expect(acceptsReception({ ...target, rules: receptionRulesSchema.parse(rules), kind })).toBe(
        expected,
      )
    },
  )

  it("matches reaction additions and removals against their own emoji lists", () => {
    const rules = receptionRulesSchema.parse({ reactionAdded: ["eyes"] })
    expect(acceptsReception({ ...target, rules, kind: "reaction_added", emoji: "eyes" })).toBe(true)
    expect(acceptsReception({ ...target, rules, kind: "reaction_added", emoji: "+1" })).toBe(false)
    expect(acceptsReception({ ...target, rules, kind: "reaction_removed", emoji: "eyes" })).toBe(
      false,
    )
  })

  it.each([
    [{ deniedChannels: ["C1"] }, false],
    [{ deniedUsers: ["U1"] }, false],
    [{ allowedChannels: [] }, false],
    [{ allowedChannels: ["C1"] }, true],
    [{ allowedUsers: ["U2"] }, false],
    [{ allowedUsers: ["U1"] }, true],
    [{ allowedChannels: ["C1"], deniedChannels: ["C1"] }, false],
    [{ allowedUsers: ["U1"], deniedUsers: ["U1"] }, false],
  ])("applies channel and user limits %j before the kind flag", (rules, expected) => {
    const parsed = receptionRulesSchema.parse({ ...rules, reactionAdded: ["eyes"] })
    expect(acceptsReception({ ...target, rules: parsed, kind: "dm" })).toBe(expected)
    expect(
      acceptsReception({ ...target, rules: parsed, kind: "reaction_added", emoji: "eyes" }),
    ).toBe(expected)
  })
})
