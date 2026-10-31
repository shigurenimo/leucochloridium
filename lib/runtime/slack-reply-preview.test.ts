import { expect, it } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"

it.each(["secret", "emoji"])(
  "preserves safe Slack reply previews at the %s boundary",
  async (boundary) => {
    const secret = "private-reply-credential-that-must-not-leak"
    const reply =
      boundary === "secret"
        ? `${"a".repeat(185)}${secret}${"z".repeat(50)}`
        : `${"a".repeat(198)}😀${"z".repeat(20)}`
    const events = new LeucoEventLog()
    events.addRedactionSecrets([secret])
    const source = new LeucoMemorySlackEventSource()
    const codex = new MemoryCodexClient()
    codex.reply = reply
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
      const previews = text.filter((line) => line.includes("[slack] monologue"))
      expect(previews).toHaveLength(1)
      expect(previews[0]?.isWellFormed()).toBe(true)
      expect(previews[0]?.length).toBeLessThan(260)
      const saved = events
        .query({ type: "log" })
        .filter(
          (entry) => entry.event.type === "log" && entry.event.line.includes("[slack] monologue"),
        )
      expect(saved).toHaveLength(1)
      expect(saved[0]?.event).toMatchObject({
        line: previews[0],
        requestId: events.query({ type: "slack.event" })[0]?.event.requestId,
      })
      expect(JSON.stringify({ previews, saved })).not.toContain("private-reply")
      if (boundary === "secret") expect(previews[0]).toContain("[redacted]")
      expect(codex.reply).toBe(reply)
    } finally {
      await runtime.stop()
      events.close()
    }
  },
)
