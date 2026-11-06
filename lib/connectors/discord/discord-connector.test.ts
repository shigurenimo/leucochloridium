import { describe, expect, it, vi } from "vitest"
import { DiscordConnector } from "@/connectors/discord/discord-connector"
import { MemoryDiscordEventSource } from "@/connectors/discord/memory-discord-event-source"
import { discordReceptionSchema } from "@/config/config-schema"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { ConnectorContext } from "@/connectors/connector"

function fixture(reception: unknown = {}) {
  const source = new MemoryDiscordEventSource()
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
  const turns: Array<{ key: string; text: string; requestId?: string }> = []
  const logs: string[] = []
  const textLogs: Array<{ line: string; level?: string; requestId?: string }> = []
  const context: ConnectorContext = {
    eventLog: new LeucoEventLog(),
    onLog: (line) => logs.push(line),
    onTextLog: (line, level, requestId) => textLogs.push({ line, level, requestId }),
    runTextTurn: async (key, text, requestId) => {
      turns.push({ key, text, requestId })
      return "internal reply"
    },
  }
  const emit = (type: string, data: Record<string, unknown>) =>
    source.emit({ type, data, receivedAt: 1000 })
  const message = async (id: string, overrides: Record<string, unknown> = {}) =>
    emit("MESSAGE_CREATE", {
      id,
      channel_id: "C1",
      guild_id: "G1",
      content: "hello",
      author: { id: "USER" },
      ...overrides,
    })
  const logEvents = () =>
    context.eventLog.query().flatMap((entry) => (entry.event.type === "log" ? [entry.event] : []))
  return { source, api, connector, turns, context, emit, message, logs, textLogs, logEvents }
}

const later = <T>(value: T) =>
  new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), 20)
  })

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
    await test.emit("THREAD_CREATE", { id: "THREAD", type: 11, member: { user_id: "BOT" } })
    await test.message("6", { channel_id: "THREAD" })
    await test.emit("THREAD_CREATE", { id: "UNJOINED", type: 11 })
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
  it("remembers non-thread channels and only warns when its own post lookup fails", async () => {
    const test = fixture()
    test.api.mockImplementation(async (_method, endpoint) => {
      if (endpoint === "/users/@me") return { id: "BOT", bot: true }
      if (endpoint === "/channels/DOWN") throw new Error("lookup unavailable")
      return { id: endpoint.split("/").pop(), type: 0 }
    })
    await test.connector.start(test.context)
    await test.message("1", { author: { id: "BOT", bot: true } })
    await test.message("2", { author: { id: "BOT", bot: true } })
    await test.message("3", { author: { id: "BOT", bot: true } })
    expect(test.api.mock.calls.filter((call) => call[1] === "/channels/C1")).toHaveLength(1)
    await test.message("4", { channel_id: "DOWN", author: { id: "BOT", bot: true } })
    expect(test.connector.getStatus().lastFailure).toBeNull()
    const warning = test.logEvents().find((event) => event.line.includes("lookup"))
    expect(warning?.level).toBe("warn")
    expect(warning?.causes?.[0]?.message).toBe("lookup unavailable")
    expect(test.textLogs.map((entry) => entry.level)).toEqual(["warn"])
    await test.connector.stop()
  })
  it("tracks membership sync and leaving threads", async () => {
    const test = fixture()
    await test.connector.start(test.context)
    await test.emit("THREAD_LIST_SYNC", {
      threads: [{ id: "T1", type: 11 }],
      members: [{ id: "T1", user_id: "BOT" }],
    })
    await test.message("1", { channel_id: "T1" })
    await test.emit("THREAD_MEMBERS_UPDATE", { id: "T1", removed_member_ids: ["BOT"] })
    await test.message("2", { channel_id: "T1" })
    await test.emit("THREAD_MEMBER_UPDATE", { id: "T1", user_id: "BOT" })
    await test.message("3", { channel_id: "T1" })
    await test.emit("THREAD_DELETE", { id: "T1" })
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
    await test.emit("MESSAGE_REACTION_ADD", { ...reaction, user_id: "BOT" })
    await test.emit("MESSAGE_REACTION_REMOVE", reaction)
    await test.emit("MESSAGE_REACTION_ADD", { ...reaction, emoji: { id: null, name: "❤️" } })
    await test.emit("MESSAGE_REACTION_ADD", reaction)
    await test.emit("MESSAGE_REACTION_ADD", {
      ...reaction,
      emoji: { id: "123", name: "custom" },
    })
    expect(test.turns).toHaveLength(2)
    expect(test.turns[0]?.text).toContain('"message_id":"1"')
    await test.connector.stop()
  })
  it("hands events to the turn queue in arrival order without waiting for each turn", async () => {
    const test = fixture()
    const gate = Promise.withResolvers<string | Error>()
    test.context.runTextTurn = (key, text, requestId) => {
      test.turns.push({ key, text, requestId })
      return gate.promise
    }
    await test.connector.start(test.context)
    const first = test.message("1", { guild_id: undefined, channel_id: "DM1" })
    const second = test.message("2", { channel_id: "C2", mentions: [{ id: "BOT" }] })
    expect(
      await Promise.race([Promise.all([first, second]).then(() => "accepted"), later("blocked")]),
    ).toBe("accepted")
    expect(test.turns.map((turn) => turn.key)).toEqual(["discord:DM1", "discord:C2"])
    expect(test.connector.getStatus().lastFailure).toBeNull()
    gate.resolve(new Error("Turn queue is full; retry after the current work finishes"))
    await later(null)
    expect(test.connector.getStatus().lastFailure?.message).toContain("Turn queue is full")
    const failures = test.logEvents().filter((event) => event.line.includes("turn failed"))
    expect(failures.map((event) => [event.level, event.requestId])).toEqual(
      test.turns.map((turn) => ["error", turn.requestId]),
    )
    expect(test.textLogs.map((entry) => [entry.level, entry.requestId])).toEqual(
      test.turns.map((turn) => ["error", turn.requestId]),
    )
    await test.connector.stop()
  })
  it("keeps Gateway log levels and causes so connection failures reach the summary", async () => {
    const test = fixture()
    await test.connector.start(test.context)
    test.source.emitLog({
      level: "info",
      action: "ws.open",
      message: "connected",
      error: null,
    })
    test.source.emitLog({
      level: "warn",
      action: "heartbeat.zombie",
      message: "heartbeat ack missing",
      error: null,
    })
    test.source.emitLog({
      level: "error",
      action: "ws.error",
      message: "socket failed",
      error: new Error("socket failed", { cause: new Error("reset") }),
    })
    expect(test.logs).toEqual(["[discord] ws.open: connected"])
    expect(test.logEvents().map((event) => [event.level, event.line])).toEqual([
      ["warn", "[discord] heartbeat.zombie: heartbeat ack missing"],
      ["error", "[discord] ws.error: socket failed"],
    ])
    expect(test.logEvents()[0]?.causes).toBeUndefined()
    expect(test.logEvents()[1]?.causes?.map((cause) => cause.message)).toEqual([
      "socket failed",
      "reset",
    ])
    expect(test.textLogs.map((entry) => entry.level)).toEqual(["warn", "error"])
    expect(test.connector.getStatus().lastFailure?.message).toBe("socket failed")
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
