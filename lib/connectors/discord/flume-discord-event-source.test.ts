import { describe, expect, it } from "vitest"
import { FlumeSource, type FlumeSourceStartContext } from "@interactive-inc/flume"
import { FlumeDiscordEventSource } from "@/connectors/discord/flume-discord-event-source"

class LocalSource extends FlumeSource {
  readonly name = "discord"
  closeError: Error | null = null
  connectError: Error | null = null
  async connect(_context: FlumeSourceStartContext): Promise<Error | null> {
    if (this.connectError !== null) return this.connectError
    this.setStatus("connected")
    return null
  }
  disconnect(): void {
    if (this.closeError !== null) throw this.closeError
  }
  send() {
    this.emit({
      source: "discord",
      type: "MESSAGE_CREATE",
      data: { id: "1" },
      meta: {},
      receivedAt: 1000,
    })
  }
}

describe("flume Discord adapter", () => {
  it("delivers real flume events and drains callbacks on stop", async () => {
    const local = new LocalSource()
    const source = new FlumeDiscordEventSource({
      botToken: "fake-token",
      intents: 0,
      source: local,
    })
    const received = Promise.withResolvers<string>()
    await source.start({
      onEvent: async (event) => {
        received.resolve(event.type)
      },
      onStatus: () => {},
      onLog: () => {},
    })
    expect(source.status()).toBe("connected")
    local.send()
    expect(await received.promise).toBe("MESSAGE_CREATE")
    await source.stop()
    expect(source.status()).toBe("disconnected")
  })
  it("does not hide rollback failures after a failed startup", async () => {
    const local = new LocalSource()
    local.connectError = new Error("connect failed")
    local.closeError = new Error("cleanup failed")
    const source = new FlumeDiscordEventSource({
      botToken: "fake-token",
      intents: 0,
      source: local,
    })
    await expect(
      source.start({ onEvent: async () => {}, onStatus: () => {}, onLog: () => {} }),
    ).rejects.toThrow("could not start")
    await expect(source.stop()).rejects.toThrow("startup cleanup failed")
  })
  it("retains shutdown failures and refuses to start a second connection", async () => {
    const local = new LocalSource()
    const source = new FlumeDiscordEventSource({
      botToken: "fake-token",
      intents: 0,
      source: local,
    })
    await source.start({ onEvent: async () => {}, onStatus: () => {}, onLog: () => {} })
    local.closeError = new Error("close failed")
    await expect(source.stop()).rejects.toThrow("shutdown failed")
    await expect(source.stop()).rejects.toThrow("shutdown failed")
    await expect(
      source.start({ onEvent: async () => {}, onStatus: () => {}, onLog: () => {} }),
    ).rejects.toThrow("already started or stopping")
  })
})
