import { describe, expect, it } from "vitest"
import { diagnoseSlackDirectMessage } from "@/actions/slack/diagnose-slack-direct-message"
import type { SlackHistoryMessage } from "@/channels/slack/leuco-slack-web-client"
import type { LeucoEvent } from "@/events/leuco-event-types"

const INBOUND: SlackHistoryMessage = {
  user: "U1",
  text: "hello",
  ts: "100.0",
  threadTs: null,
  subtype: null,
  botId: null,
}

describe("diagnoseSlackDirectMessage", () => {
  it("identifies a DM present in history but missing from Socket Mode", () => {
    const result = diagnoseSlackDirectMessage({
      conversationId: "D1",
      botUserId: "UBOT",
      messages: [INBOUND],
      events: [],
      eventLogAvailable: true,
    })

    expect(result.status).toBe("socket_event_missing")
    expect(result.socketMode).toBe("missing")
    expect(result.nextAction).toContain("message.im")
  })

  it("reports a visible bot reply after a delivered turn", () => {
    const events: LeucoEvent[] = [
      {
        ts: 1,
        type: "slack.event",
        project: "demo",
        channel: "D1",
        event: {
          kind: "message",
          channel: "D1",
          user: "U1",
          rawText: "hello",
          text: "hello",
          threadTs: "100.0",
          ts: "100.0",
          isThreadRoot: true,
          mentioned: true,
          source: "message",
        },
      },
      {
        ts: 2,
        type: "turn.start",
        project: "demo",
        threadKey: "slack:D1:100.0",
        input: "hello",
      },
      {
        ts: 3,
        type: "turn.complete",
        project: "demo",
        threadKey: "slack:D1:100.0",
        reply: "done",
      },
    ]
    const result = diagnoseSlackDirectMessage({
      conversationId: "D1",
      botUserId: "UBOT",
      messages: [INBOUND, { ...INBOUND, user: "UBOT", text: "hello back", ts: "101.0" }],
      events,
      eventLogAvailable: true,
    })

    expect(result.status).toBe("replied")
    expect(result.botReply).toEqual({ status: "posted", ts: "101.0" })
  })

  it("surfaces a turn error after Socket Mode delivery", () => {
    const events: LeucoEvent[] = [
      {
        ts: 1,
        type: "slack.event",
        project: "demo",
        channel: "D1",
        event: {
          kind: "message",
          channel: "D1",
          user: "U1",
          rawText: "hello",
          text: "hello",
          threadTs: "100.0",
          ts: "100.0",
          isThreadRoot: true,
          mentioned: true,
          source: "message",
        },
      },
      {
        ts: 2,
        type: "turn.start",
        project: "demo",
        threadKey: "slack:D1:100.0",
        input: "hello",
      },
      {
        ts: 3,
        type: "turn.error",
        project: "demo",
        threadKey: "slack:D1:100.0",
        error: "selected model is at capacity",
      },
    ]
    const result = diagnoseSlackDirectMessage({
      conversationId: "D1",
      botUserId: "UBOT",
      messages: [INBOUND],
      events,
      eventLogAvailable: true,
    })

    expect(result.status).toBe("turn_failed")
    expect(result.error).toBe("selected model is at capacity")
  })
})
