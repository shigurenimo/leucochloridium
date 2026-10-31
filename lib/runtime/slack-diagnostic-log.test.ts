import { expect, it } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"

const levels: Array<"warn" | "error"> = ["warn", "error"]

for (const sinkFails of [false, true]) {
  it.each(levels)(`records a Slack %s once (text sink fails: ${sinkFails})`, async (level) => {
    const events = new LeucoEventLog()
    const secret = "synthetic-slack-diagnostic-secret"
    events.addRedactionSecrets([secret])
    const source = new LeucoMemorySlackEventSource()
    const text: Array<{ line: string; level: string | undefined }> = []
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex: new MemoryCodexClient(),
      eventLog: events,
      env: {},
      connections: [
        new LeucoSlackConnector({
          eventSource: source,
          webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
        }),
      ],
      onLog: (line, severity) => {
        text.push({ line, level: severity })
        if (sinkFails && line.includes("ws.error")) throw new Error("synthetic text sink failure")
      },
    })
    try {
      await runtime.start()
      const sinceSeq = events.query({ order: "desc", limit: 1 })[0]?.seq ?? 0
      const cause = Object.assign(new Error(`socket reset ${secret}`), { code: "ECONNRESET" })
      source.log({
        level,
        action: "ws.error",
        message: `socket diagnostic ${secret}`,
        error: new Error("connection failed", { cause }),
        detail: null,
        timestamp: 123,
      })
      const recorded = events.query({ sinceSeq })
      expect(recorded).toHaveLength(sinkFails ? 2 : 1)
      if (sinkFails) {
        expect(runtime.getStatus().logConsumer.healthy).toBe(false)
        expect(recorded[1]?.event).toMatchObject({
          type: "log",
          level: "error",
          line: expect.stringContaining("Log consumer failed"),
        })
      }
      expect(recorded[0]?.event).toMatchObject({
        type: "slack.error",
        level,
        action: "ws.error",
        causes: expect.arrayContaining([expect.objectContaining({ code: "ECONNRESET" })]),
      })
      expect(JSON.stringify(recorded)).not.toContain(secret)
      const mirrored = text.filter((entry) => entry.line.includes("ws.error"))
      expect(mirrored).toHaveLength(1)
      expect(mirrored[0]?.level).toBe(level)
      expect(mirrored[0]?.line).not.toContain(secret)
    } finally {
      await runtime.stop()
      events.close()
    }
  })
}

it.each([false, true])(
  "records one Slack turn failure and one text attempt (sink fails: %s)",
  async (sinkFails) => {
    const events = new LeucoEventLog()
    const source = new LeucoMemorySlackEventSource()
    const codex = new MemoryCodexClient()
    codex.reply = Object.assign(new Error("turn diagnostic failure"), { code: "TURN_FAILED" })
    const text: string[] = []
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      eventLog: events,
      env: {},
      connections: [
        new LeucoSlackConnector({
          eventSource: source,
          webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
          ackMode: "off",
        }),
      ],
      onLog: (line) => {
        text.push(line)
        if (sinkFails && line.includes("[slack] turn failed:"))
          throw new Error("turn text sink failed")
      },
    })
    try {
      await runtime.start()
      await source.emit({
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
      const slackErrors = events.query({ type: "slack.error" })
      expect(slackErrors).toHaveLength(1)
      expect(slackErrors[0]?.event).toMatchObject({
        action: "turn.failed",
        causes: [expect.objectContaining({ code: "TURN_FAILED" })],
      })
      expect(
        events
          .query({ type: "log" })
          .filter(
            (entry) =>
              entry.event.type === "log" && entry.event.line.includes("[slack] turn failed:"),
          ),
      ).toHaveLength(0)
      expect(text.filter((line) => line.includes("[slack] turn failed:"))).toHaveLength(1)
      expect(runtime.getStatus().logConsumer.healthy).toBe(!sinkFails)
    } finally {
      await runtime.stop()
      events.close()
    }
  },
)
