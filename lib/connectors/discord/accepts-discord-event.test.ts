import { describe, expect, it } from "vitest"
import { discordReceptionSchema } from "@/config/config-schema"
import { acceptsDiscordEvent } from "@/connectors/discord/accepts-discord-event"

const target: { channel: string; user: string; kind: "mention" } = {
  channel: "C1",
  user: "U1",
  kind: "mention",
}

describe("acceptsDiscordEvent", () => {
  it("does not apply guild rules to direct messages", () => {
    const rules = discordReceptionSchema.parse({ allowedGuilds: [], deniedGuilds: ["G1"] })
    expect(acceptsDiscordEvent({ ...target, kind: "dm", rules, guild: null })).toBe(true)
  })

  it("rejects denied guilds and guilds outside the allowed list", () => {
    const rules = discordReceptionSchema.parse({
      allowedGuilds: ["G1", "G2"],
      deniedGuilds: ["G2"],
    })
    expect(acceptsDiscordEvent({ ...target, rules, guild: "G1" })).toBe(true)
    expect(acceptsDiscordEvent({ ...target, rules, guild: "G2" })).toBe(false)
    expect(acceptsDiscordEvent({ ...target, rules, guild: "G3" })).toBe(false)
  })

  it("still applies channel and user rules after guild rules pass", () => {
    const channelDenied = discordReceptionSchema.parse({ deniedChannels: ["C1"] })
    const userDenied = discordReceptionSchema.parse({ deniedUsers: ["U1"] })
    expect(acceptsDiscordEvent({ ...target, rules: channelDenied, guild: "G1" })).toBe(false)
    expect(acceptsDiscordEvent({ ...target, kind: "dm", rules: userDenied, guild: null })).toBe(
      false,
    )
  })
})
