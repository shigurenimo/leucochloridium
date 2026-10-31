import { afterEach, expect, it, vi } from "vitest"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.restoreAllMocks())

it.each(["resolving bot identity", "connecting to Slack", "ready —"])(
  "does not advance startup after the %s diagnostic stops the connector",
  async (phase) => {
    const eventSource = new LeucoMemorySlackEventSource()
    const startSource = vi.spyOn(eventSource, "start")
    const webClient = new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } })
    const connector = new LeucoSlackConnector({ eventSource, webClient })
    const eventLog = new LeucoEventLog({ diagnosticOutput: null })
    const stopped: { promise: Promise<void> | null } = { promise: null }
    try {
      const starting = connector.start({
        eventLog,
        onLog: (line) => {
          if (line.includes(phase) && stopped.promise === null) stopped.promise = connector.stop()
        },
        runTextTurn: async () => "",
      })
      const failure = await starting.then(
        () => null,
        (error: unknown) => error,
      )
      await stopped.promise
      expect(stopped.promise).not.toBeNull()
      expect(webClient.calls.authTest).toHaveLength(phase === "resolving bot identity" ? 0 : 1)
      expect(startSource).toHaveBeenCalledTimes(phase === "ready —" ? 1 : 0)
      expect(failure).toBeInstanceOf(Error)
      expect(eventSource.status()).toBe("disconnected")
    } finally {
      await connector.stop()
      eventLog.close()
    }
  },
)
