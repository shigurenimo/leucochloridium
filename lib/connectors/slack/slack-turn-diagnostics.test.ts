import { expect, it } from "vitest"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
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
