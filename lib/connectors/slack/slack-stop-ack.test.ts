import { afterEach, expect, it, vi } from "vitest"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.restoreAllMocks())

it.each(["success", "silent", "failure", "failure event"])(
  "only removes the progress reaction after a %s diagnostic stops the connector",
  async (outcome) => {
    const eventSource = new LeucoMemorySlackEventSource()
    const webClient = new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } })
    const connector = new LeucoSlackConnector({ eventSource, webClient })
    const stopped: { promise: Promise<void> | null } = { promise: null }
    if (outcome === "failure event")
      vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementation(() => {
        throw new Error("synthetic history failure")
      })
    const eventLog = new LeucoEventLog({
      diagnosticOutput: null,
      onFallback: (event) => {
        if (event.type === "slack.error" && stopped.promise === null)
          stopped.promise = connector.stop()
      },
    })
    try {
      await connector.start({
        eventLog,
        onLog: (line) => {
          if (
            stopped.promise === null &&
            (line.includes("monologue (") ||
              line.includes("agent silent (") ||
              line.includes("turn failed:"))
          )
            stopped.promise = connector.stop()
        },
        runTextTurn: async () => {
          if (outcome.startsWith("failure")) return new Error("synthetic turn failure")
          return outcome === "silent" ? "" : "done"
        },
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
      await stopped.promise
      expect(stopped.promise).not.toBeNull()
      expect(webClient.calls.reactionsAdd).toEqual([
        { channel: "C1", timestamp: "1.0", name: "hourglass_flowing_sand" },
      ])
      expect(webClient.calls.reactionsRemove).toEqual([
        { channel: "C1", timestamp: "1.0", name: "hourglass_flowing_sand" },
      ])
      expect(eventSource.status()).toBe("disconnected")
    } finally {
      await connector.stop()
      eventLog.close()
    }
  },
)
