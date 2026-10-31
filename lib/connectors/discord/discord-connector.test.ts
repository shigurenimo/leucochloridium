import { describe, expect, it, vi } from "vitest"
import { DiscordConnector } from "@/connectors/discord/discord-connector"
import {
  DiscordEventSource,
  type DiscordSourceHandlers,
} from "@/connectors/discord/discord-event-source"
import { discordReceptionSchema } from "@/config/config-schema"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ConnectorContext } from "@/connectors/connector"

class MemorySource extends DiscordEventSource {
  handlers: DiscordSourceHandlers | null = null
  async start(handlers: DiscordSourceHandlers) {
    this.handlers = handlers
  }
  async stop() {
    this.handlers = null
  }
  status() {
    return this.handlers === null ? "disconnected" : "connected"
  }
  async emit(type: string, data: Record<string, unknown>) {
    await this.handlers?.onEvent({ type, data, receivedAt: 1000 })
  }
}

function fixture(reception: unknown = {}) {
  const source = new MemorySource()
  const api = vi.fn(async (_method: string, endpoint: string): Promise<unknown> =>
    endpoint === "/users/@me"
      ? { id: "BOT", bot: true }
      : { id: endpoint.split("/").pop(), type: 11 },
  )
  const connector = new DiscordConnector({
    source,
    api,
    reception: discordReceptionSchema.parse(reception),
  })
  const turns: Array<{ key: string; text: string }> = []
  const logs: string[] = []
  const context: ConnectorContext = {
    eventLog: new LeucoEventLog(),
    onLog: (line) => logs.push(line),
    runTextTurn: async (key, text) => {
      turns.push({ key, text })
      return "internal reply"
    },
  }
  const message = async (id: string, overrides: Record<string, unknown> = {}) =>
    source.emit("MESSAGE_CREATE", {
      id,
      channel_id: "C1",
      guild_id: "G1",
      content: "hello",
      author: { id: "USER" },
      ...overrides,
    })
  return { source, api, connector, turns, context, message, logs }
}

describe("Discord connector", () => {
  it("only starts turns for DM, mention or joined-thread messages by default; ignores bots and duplicates", async () => {
    const test = fixture()
    await test.connector.start(test.context)
    await test.message("1")
    await test.message("2", { guild_id: undefined })
    await test.message("3", { mentions: [{ id: "BOT" }] })
    await test.message("3", { mentions: [{ id: "BOT" }] })
    await test.message("4", { author: { id: "OTHERBOT", bot: true }, mentions: [{ id: "BOT" }] })
    await test.message("5", { webhook_id: "HOOK", mentions: [{ id: "BOT" }] })
    await test.source.emit("THREAD_CREATE", { id: "THREAD", type: 11, member: { user_id: "BOT" } })
    await test.message("6", { channel_id: "THREAD" })
    await test.source.emit("THREAD_CREATE", { id: "UNJOINED", type: 11 })
    await test.message("7", { channel_id: "UNJOINED" })
    expect(test.turns.map((turn) => turn.key)).toEqual([
      "discord:C1",
      "discord:C1",
      "discord:THREAD",
    ])
    expect(test.turns[0]?.text).toContain("final answers stay internal")
    expect(test.api).toHaveBeenCalledTimes(1)
    await test.connector.stop()
  })
  it("restricts guilds, channels and users before any model calls", async () => {
    const test = fixture({
      allowedGuilds: ["G1"],
      allowedChannels: ["C1"],
      allowedUsers: ["USER"],
      deniedUsers: ["DENIED"],
    })
    await test.connector.start(test.context)
    await test.message("1", { guild_id: "G2", mentions: [{ id: "BOT" }] })
    await test.message("2", { channel_id: "C2", mentions: [{ id: "BOT" }] })
    await test.message("3", { author: { id: "DENIED" }, mentions: [{ id: "BOT" }] })
    await test.message("4", { mentions: [{ id: "BOT" }] })
    expect(test.turns).toHaveLength(1)
    await test.connector.stop()
  })
  it("tracks own posts inside threads without treating ordinary bot posts as channel participation", async () => {
    const test = fixture()
    test.api.mockImplementation(async (_method, endpoint) =>
      endpoint === "/users/@me"
        ? { id: "BOT", bot: true }
        : { id: endpoint.split("/").pop(), type: endpoint.endsWith("THREAD") ? 11 : 0 },
    )
    await test.connector.start(test.context)
    await test.message("1", { author: { id: "BOT", bot: true } })
    await test.message("2")
    await test.message("3", { channel_id: "THREAD", author: { id: "BOT", bot: true } })
    await test.message("4", { channel_id: "THREAD" })
    expect(test.turns.map((turn) => turn.key)).toEqual(["discord:THREAD"])
    await test.connector.stop()
  })
  it("tracks membership sync and leaving threads", async () => {
    const test = fixture()
    await test.connector.start(test.context)
    await test.source.emit("THREAD_LIST_SYNC", {
      threads: [{ id: "T1", type: 11 }],
      members: [{ id: "T1", user_id: "BOT" }],
    })
    await test.message("1", { channel_id: "T1" })
    await test.source.emit("THREAD_MEMBERS_UPDATE", { id: "T1", removed_member_ids: ["BOT"] })
    await test.message("2", { channel_id: "T1" })
    await test.source.emit("THREAD_MEMBER_UPDATE", { id: "T1", user_id: "BOT" })
    await test.message("3", { channel_id: "T1" })
    await test.source.emit("THREAD_DELETE", { id: "T1" })
    await test.message("4", { channel_id: "T1" })
    expect(test.turns).toHaveLength(2)
    await test.connector.stop()
  })
  it("only starts turns for explicitly enabled reaction names and never its own reactions", async () => {
    const test = fixture({ reactionAdded: ["👀", "custom:123"] })
    await test.connector.start(test.context)
    const reaction = {
      user_id: "USER",
      channel_id: "C1",
      message_id: "1",
      guild_id: "G1",
      emoji: { id: null, name: "👀" },
    }
    await test.source.emit("MESSAGE_REACTION_ADD", { ...reaction, user_id: "BOT" })
    await test.source.emit("MESSAGE_REACTION_REMOVE", reaction)
    await test.source.emit("MESSAGE_REACTION_ADD", { ...reaction, emoji: { id: null, name: "❤️" } })
    await test.source.emit("MESSAGE_REACTION_ADD", reaction)
    await test.source.emit("MESSAGE_REACTION_ADD", {
      ...reaction,
      emoji: { id: "123", name: "custom" },
    })
    expect(test.turns).toHaveLength(2)
    expect(test.turns[0]?.text).toContain('"message_id":"1"')
    await test.connector.stop()
  })
  it("drains accepted turns during shutdown and suppresses late failures", async () => {
    const test = fixture()
    const started = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<string | Error>()
    test.context.runTextTurn = async () => {
      started.resolve()
      return gate.promise
    }
    await test.connector.start(test.context)
    const event = test.message("1", { guild_id: undefined })
    await started.promise
    const stopping = test.connector.stop()
    expect(await Promise.race([stopping.then(() => "stopped"), Promise.resolve("draining")])).toBe(
      "draining",
    )
    gate.resolve(new Error("late failure"))
    await Promise.all([event, stopping])
    expect(test.connector.getStatus().lastFailure).toBeNull()
    expect(test.connector.getIdentity().botUserId).toBeNull()
  })
  it("does not let an old startup overwrite a later connection", async () => {
    const test = fixture()
    const pending = Promise.withResolvers<unknown>()
    test.api.mockImplementationOnce(() => pending.promise)
    const starting = test.connector.start(test.context)
    const failed = expect(starting).rejects.toThrow("stopped during startup")
    await test.connector.stop()
    await test.connector.start(test.context)
    pending.resolve({ id: "OLD-BOT", bot: true })
    await failed
    expect(test.connector.getIdentity().botUserId).toBe("BOT")
    await test.message("1", { mentions: [{ id: "BOT" }] })
    expect(test.turns).toHaveLength(1)
    await test.connector.stop()
  })
  it("closes the source when startup fails and rejects non-bot credentials", async () => {
    const test = fixture()
    test.api.mockResolvedValueOnce({ id: "USER", bot: false })
    const stop = vi.spyOn(test.source, "stop")
    await expect(test.connector.start(test.context)).rejects.toThrow("bot account")
    expect(stop).toHaveBeenCalledOnce()
    expect(test.connector.getStatus().lastFailure?.message).toContain("bot account")
  })
})
