import { describe, expect, it, vi } from "vitest"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { errorDetails } from "@/error-details"

const observation = vi.hoisted(() => ({ stops: 0, starts: 0 }))

// Keep the installed Flume runtime real; only replace its network source.
vi.mock("@interactive-inc/flume/slack", () => ({
  FlumeSlackSource: class {
    readonly name = "slack"
    async start() {
      observation.starts += 1
      return null
    }
    async stop() {
      observation.stops += 1
      return new Error("network source disconnect failed")
    }
    status() {
      return "connected"
    }
  },
}))

describe("installed Flume close contract", () => {
  it("propagates resolved source errors and never reopens over unconfirmed cleanup", async () => {
    const source = new LeucoFlumeSlackEventSource({ appToken: "xapp-test", botToken: "xoxb-test" })
    await source.start({ onEvent: async () => {}, onLog: () => {} })
    const failure = await source.stop().then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    expect(errorDetails(failure).some((cause) => cause.code === "FLUME_STOP_FAILED")).toBe(true)
    expect(String(failure)).toContain("network source disconnect failed")
    await expect(source.start({ onEvent: async () => {} })).rejects.toThrow("cleanup")
    await expect(source.stop()).rejects.toThrow("network source disconnect failed")
    expect(observation.starts).toBe(1)
    expect(observation.stops).toBe(1)
  })
})
