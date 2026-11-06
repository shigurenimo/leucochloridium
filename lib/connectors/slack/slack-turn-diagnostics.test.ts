import { expect, it } from "vitest"
import { receptionRulesSchema } from "@/config/config-schema"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import type { LeucoSlackEnvelope } from "@/connectors/slack/leuco-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each([false, true])(
  "keeps bounded masked turn causes in the Slack event (large: %s)",
  async (large) => {
    const secret = "synthetic-turn-private"
    const message = large
      ? `${"a".repeat(3950)}${secret}${"z".repeat(100000)}`
      : `turn failed ${secret}`
    const nested = Object.assign(new Error(`transport failed ${secret}`), { code: "ETIMEDOUT" })
    const primary = Object.assign(new Error(message, { cause: nested }), { code: "TURN_FAILED" })
    const eventSource = new LeucoMemorySlackEventSource()
    const connector = new LeucoSlackConnector({
      eventSource,
      ackMode: "off",
      webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
    })
    const eventLog = new LeucoEventLog()
    eventLog.addRedactionSecrets([secret])
    const lines: string[] = []
    try {
      await connector.start({
        eventLog,
        onLog: (line) => {
          lines.push(line)
        },
        runTextTurn: async () => primary,
      })
      await eventSource.emit({
        type: "events_api",
        receivedAt: 1000,
        payload: {
          event: {
            type: "message",
            channel: "C1",
            user: "UHUMAN",
            text: "<@UBOT> hello",
            ts: "1.0",
          },
        },
      })
      const entries = eventLog.query({ type: "slack.error" })
      expect(entries).toHaveLength(1)
      const event = entries[0]?.event
      if (event?.type !== "slack.error") throw new Error("Missing Slack turn failure")
      expect(event.action).toBe("turn.failed")
      expect(event.error?.length).toBeLessThanOrEqual(4000)
      expect(event.causes).toEqual([
        expect.objectContaining({ code: "TURN_FAILED", stack: expect.any(String) }),
        expect.objectContaining({ code: "ETIMEDOUT", message: "transport failed [redacted]" }),
      ])
      expect(event.requestId).toBe(eventLog.query({ type: "slack.event" })[0]?.event.requestId)
      expect(lines.find((line) => line.includes("turn failed:"))?.length).toBeLessThan(4100)
      expect(JSON.stringify({ entries, lines })).not.toContain(secret)
      expect(primary.message).toBe(message)
    } finally {
      await connector.stop()
      eventLog.close()
    }
  },
)

type TextLine = { line: string; level: string | undefined; requestId: string | undefined }

const reactionEnvelope: LeucoSlackEnvelope = {
  type: "events_api",
  receivedAt: 1000,
  payload: {
    event: {
      type: "reaction_added",
      user: "UHUMAN",
      reaction: "eyes",
      event_ts: "2.0",
      item: { type: "message", channel: "C1", ts: "1.0" },
    },
  },
}

const mentionEnvelope: LeucoSlackEnvelope = {
  type: "events_api",
  receivedAt: 1000,
  payload: {
    event: {
      type: "message",
      channel: "C1",
      user: "UHUMAN",
      text: "<@UBOT> hello",
      ts: "1.0",
    },
  },
}

it("records a reaction turn failure once with masked causes under the event request ID", async () => {
  const secret = "synthetic-reaction-private"
  const nested = Object.assign(new Error(`transport failed ${secret}`), { code: "ETIMEDOUT" })
  const primary = Object.assign(new Error(`reaction turn ${secret}`, { cause: nested }), {
    code: "TURN_FAILED",
  })
  const eventSource = new LeucoMemorySlackEventSource()
  const connector = new LeucoSlackConnector({
    eventSource,
    ackMode: "off",
    reception: receptionRulesSchema.parse({ reactionAdded: ["eyes"] }),
    webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
  })
  const eventLog = new LeucoEventLog()
  eventLog.addRedactionSecrets([secret])
  const lines: TextLine[] = []
  const textLines: TextLine[] = []
  try {
    await connector.start({
      eventLog,
      onLog: (line, level, requestId) => {
        lines.push({ line, level, requestId })
      },
      onTextLog: (line, level, requestId) => {
        textLines.push({ line, level, requestId })
      },
      runTextTurn: async () => primary,
    })
    await eventSource.emit(reactionEnvelope)
    const requestId = eventLog.query({ type: "slack.event" })[0]?.event.requestId
    expect(typeof requestId).toBe("string")
    const failures = eventLog.query({ type: "slack.error" }).map((entry) => entry.event)
    expect(failures).toEqual([
      expect.objectContaining({
        requestId,
        level: "error",
        action: "turn.failed",
        error: "reaction turn [redacted]",
        causes: [
          expect.objectContaining({ code: "TURN_FAILED", stack: expect.any(String) }),
          expect.objectContaining({ code: "ETIMEDOUT", message: "transport failed [redacted]" }),
        ],
      }),
    ])
    expect(textLines).toEqual([
      { line: "[slack] reaction turn failed: reaction turn [redacted]", level: "error", requestId },
    ])
    expect(lines.filter((entry) => entry.line.includes("reaction turn failed"))).toEqual([])
    expect(JSON.stringify({ failures, lines, textLines })).not.toContain(secret)
  } finally {
    await connector.stop()
    eventLog.close()
  }
})

it("falls back to onLog with level and request ID for a reaction turn failure", async () => {
  const eventSource = new LeucoMemorySlackEventSource()
  const connector = new LeucoSlackConnector({
    eventSource,
    ackMode: "off",
    reception: receptionRulesSchema.parse({ reactionAdded: ["eyes"] }),
    webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
  })
  const eventLog = new LeucoEventLog()
  const lines: TextLine[] = []
  try {
    await connector.start({
      eventLog,
      onLog: (line, level, requestId) => {
        lines.push({ line, level, requestId })
      },
      runTextTurn: async () => new Error("reaction turn failed upstream"),
    })
    await eventSource.emit(reactionEnvelope)
    const requestId = eventLog.query({ type: "slack.event" })[0]?.event.requestId
    expect(lines.filter((entry) => entry.line.includes("reaction turn failed"))).toEqual([
      {
        line: "[slack] reaction turn failed: reaction turn failed upstream",
        level: "error",
        requestId,
      },
    ])
  } finally {
    await connector.stop()
    eventLog.close()
  }
})

it("records failed ack reactions as warnings on the triggering request", async () => {
  const secret = "synthetic-ack-private"
  const scopeFailure = () => {
    throw Object.assign(new Error(`missing_scope ${secret}`), {
      code: "slack_webapi_platform_error",
    })
  }
  const eventSource = new LeucoMemorySlackEventSource()
  const connector = new LeucoSlackConnector({
    eventSource,
    webClient: new LeucoMemorySlackWebClient({
      authTest: { userId: "UBOT" },
      reactionsAdd: scopeFailure,
      reactionsRemove: scopeFailure,
    }),
  })
  const eventLog = new LeucoEventLog()
  eventLog.addRedactionSecrets([secret])
  const lines: TextLine[] = []
  const textLines: TextLine[] = []
  try {
    await connector.start({
      eventLog,
      onLog: (line, level, requestId) => {
        lines.push({ line, level, requestId })
      },
      onTextLog: (line, level, requestId) => {
        textLines.push({ line, level, requestId })
      },
      runTextTurn: async () => "done",
    })
    await eventSource.emit(mentionEnvelope)
    const requestId = eventLog.query({ type: "slack.event" })[0]?.event.requestId
    expect(typeof requestId).toBe("string")
    const failures = eventLog.query({ type: "slack.error" }).map((entry) => entry.event)
    expect(failures.map((event) => (event.type === "slack.error" ? event.action : null))).toEqual([
      "reactions.add",
      "reactions.add",
      "reactions.remove",
    ])
    for (const event of failures)
      expect(event).toMatchObject({
        requestId,
        level: "warn",
        error: "missing_scope [redacted]",
        causes: [expect.objectContaining({ code: "slack_webapi_platform_error" })],
      })
    expect(failures[0]).toMatchObject({
      message: "reactions.add failed (channel=C1 ts=1.0 :hourglass_flowing_sand:)",
    })
    expect(textLines).toHaveLength(3)
    for (const entry of textLines) expect(entry).toMatchObject({ level: "warn", requestId })
    expect(textLines[0]?.line).toBe(
      "[slack] reactions.add failed (channel=C1 ts=1.0 :hourglass_flowing_sand:): missing_scope [redacted]",
    )
    expect(lines.filter((entry) => entry.line.includes("reactions."))).toEqual([])
    expect(eventLog.query({ summary: true, type: "slack.error" })).toHaveLength(3)
    expect(JSON.stringify({ failures, lines, textLines })).not.toContain(secret)
  } finally {
    await connector.stop()
    eventLog.close()
  }
})

it("does not report idempotent ack reaction misses", async () => {
  const eventSource = new LeucoMemorySlackEventSource()
  const connector = new LeucoSlackConnector({
    eventSource,
    webClient: new LeucoMemorySlackWebClient({
      authTest: { userId: "UBOT" },
      reactionsAdd: () => {
        throw new Error("already_reacted")
      },
      reactionsRemove: () => {
        throw new Error("no_reaction")
      },
    }),
  })
  const eventLog = new LeucoEventLog()
  const lines: string[] = []
  try {
    await connector.start({
      eventLog,
      onLog: (line) => {
        lines.push(line)
      },
      runTextTurn: async () => "done",
    })
    await eventSource.emit(mentionEnvelope)
    expect(eventLog.query({ type: "slack.error" })).toHaveLength(0)
    expect(lines.filter((line) => line.includes("reactions."))).toEqual([])
  } finally {
    await connector.stop()
    eventLog.close()
  }
})
