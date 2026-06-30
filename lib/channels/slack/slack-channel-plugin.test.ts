import { describe, expect, it } from "vitest"
import { LeucoMemorySlackEventSource } from "@/channels/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/channels/slack/leuco-memory-slack-web-client"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { ChannelPluginContext } from "@/engine/channel-plugin"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import type { LeucoEvent } from "@/events/leuco-event-types"

const makeCtx = (): {
  ctx: ChannelPluginContext
  logs: string[]
  turns: Array<{ threadKey: string; text: string }>
  events: LeucoEvent[]
} => {
  const logs: string[] = []
  const turns: Array<{ threadKey: string; text: string }> = []
  const events: LeucoEvent[] = []
  const bus = new LeucoEventBus()
  bus.subscribe((event) => events.push(event))
  return {
    logs,
    turns,
    events,
    ctx: {
      cwd: "/tmp/project",
      projectName: "demo",
      bus,
      onLog: (line) => logs.push(line),
      runTextTurn: async (threadKey, text) => {
        turns.push({ threadKey, text })
        return ""
      },
    },
  }
}

describe("LeucoSlackChannelPlugin", () => {
  it("does not add ack reactions by default", async () => {
    const ts = `${Math.floor(Date.now() / 1000) + 1}.0`
    const eventSource = new LeucoMemorySlackEventSource()
    const webClient = new LeucoMemorySlackWebClient({
      authTest: { userId: "UBOT" },
    })
    const plugin = new LeucoSlackChannelPlugin({
      name: "main",
      eventSource,
      webClient,
      usesUserToken: true,
    })
    const { ctx, turns } = makeCtx()

    await plugin.start(ctx)
    await eventSource.emit({
      type: "events_api",
      receivedAt: 1_000,
      payload: {
        event: {
          type: "message",
          channel: "D1",
          user: "U_USER",
          text: "hello dm",
          ts,
        },
      },
    })
    await plugin.stop()

    expect(turns).toHaveLength(1)
    expect(webClient.calls.reactionsAdd).toHaveLength(0)
    expect(webClient.calls.reactionsRemove).toHaveLength(0)
  })

  it("handles DM messages from Socket Mode without polling Slack history", async () => {
    const ts = `${Math.floor(Date.now() / 1000) + 1}.0`
    const eventSource = new LeucoMemorySlackEventSource()
    const webClient = new LeucoMemorySlackWebClient({
      authTest: { userId: "UBOT" },
    })
    const plugin = new LeucoSlackChannelPlugin({
      name: "main",
      eventSource,
      webClient,
      usesUserToken: true,
      ackMode: "off",
    })
    const { ctx, turns, events } = makeCtx()

    await plugin.start(ctx)
    await eventSource.emit({
      type: "events_api",
      receivedAt: 1_000,
      payload: {
        event: {
          type: "message",
          channel: "D1",
          user: "U_USER",
          text: "hello dm",
          ts,
        },
      },
    })
    await plugin.stop()

    expect(webClient.calls.authTest).toHaveLength(1)
    expect(webClient.calls.conversationsList).toHaveLength(0)
    expect(webClient.calls.conversationsHistory).toHaveLength(0)
    expect(webClient.calls.searchMessages).toHaveLength(0)
    expect(turns).toHaveLength(1)
    expect(turns[0]?.threadKey).toBe(`main:D1:${ts}`)
    expect(turns[0]?.text).toContain('mentioned="true"')
    expect(turns[0]?.text).toContain("hello dm")
    expect(events.some((event) => event.type === "slack.event")).toBe(true)
  })

  it("handles delayed Socket Mode deliveries without timestamp-based stale dropping", async () => {
    const ts = `${Math.floor(Date.now() / 1000) - 120}.0`
    const eventSource = new LeucoMemorySlackEventSource()
    const webClient = new LeucoMemorySlackWebClient({
      authTest: { userId: "UBOT" },
    })
    const plugin = new LeucoSlackChannelPlugin({
      name: "main",
      eventSource,
      webClient,
      usesUserToken: true,
      ackMode: "off",
    })
    const { ctx, turns, logs } = makeCtx()

    await plugin.start(ctx)
    await eventSource.emit({
      type: "events_api",
      receivedAt: Date.now(),
      payload: {
        event: {
          type: "message",
          channel: "D1",
          user: "U_USER",
          text: "delayed but socket-delivered",
          ts,
        },
      },
    })
    await plugin.stop()

    expect(turns).toHaveLength(1)
    expect(turns[0]?.threadKey).toBe(`main:D1:${ts}`)
    expect(turns[0]?.text).toContain("delayed but socket-delivered")
    expect(logs.some((line) => line.includes("skip stale socket event"))).toBe(false)
  })
})
