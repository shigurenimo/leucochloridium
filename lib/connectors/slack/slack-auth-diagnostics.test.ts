import { expect, it, vi } from "vitest"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each([null, "", " \t"])(
  "rejects an unresolved injected identity before socket startup: %j",
  async (userId) => {
    const source = new LeucoMemorySlackEventSource()
    const start = vi.spyOn(source, "start")
    const eventLog = new LeucoEventLog()
    const connector = new LeucoSlackConnector({
      eventSource: source,
      webClient: new LeucoMemorySlackWebClient({ authTest: { userId } }),
    })
    try {
      const failure = await connector
        .start({
          eventLog,
          onLog: () => {},
          runTextTurn: async () => "",
        })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain("auth.test did not resolve")
      expect(source.status()).toBe("disconnected")
      expect(start).not.toHaveBeenCalled()
      const entries = eventLog.query({ type: "slack.error" })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.event).toMatchObject({ action: "auth.test", level: "error" })
      expect(connector.getStatus().lastFailure).not.toBeNull()
    } finally {
      await connector.stop()
      eventLog.close()
    }
  },
)

it("records masked auth causes and codes in the single Slack error event", async () => {
  const secret = "synthetic-auth-private"
  const nested = Object.assign(new Error(`certificate failed ${secret}`), {
    code: "CERT_HAS_EXPIRED",
  })
  const primary = Object.assign(new Error(`auth request failed ${secret}`, { cause: nested }), {
    code: "ECONNRESET",
  })
  const connector = new LeucoSlackConnector({
    eventSource: new LeucoMemorySlackEventSource(),
    webClient: new LeucoMemorySlackWebClient({
      authTest: () => {
        throw primary
      },
    }),
  })
  const eventLog = new LeucoEventLog()
  eventLog.addRedactionSecrets([secret])
  try {
    const failure = await connector
      .start({
        eventLog,
        onLog: () => {},
        runTextTurn: async () => "",
      })
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ cause: primary })
    const entries = eventLog.query({ type: "slack.error" })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toMatchObject({
      action: "auth.test",
      level: "error",
      error: "auth request failed [redacted]",
      causes: [
        expect.objectContaining({
          code: "ECONNRESET",
          message: "auth request failed [redacted]",
          stack: expect.any(String),
        }),
        expect.objectContaining({
          code: "CERT_HAS_EXPIRED",
          message: "certificate failed [redacted]",
          stack: expect.any(String),
        }),
      ],
    })
    expect(connector.getStatus().lastFailure?.message).toBe("auth request failed [redacted]")
    expect(JSON.stringify(entries)).not.toContain(secret)
  } finally {
    await connector.stop()
    eventLog.close()
  }
})
