import { expect, it, vi } from "vitest"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each(["resolved", "rejected"])(
  "does not close a new session after stale auth is %s",
  async (outcome) => {
    const firstAuth = Promise.withResolvers<{ userId: string }>()
    const attempts = { count: 0 }
    const webClient = new LeucoMemorySlackWebClient({
      authTest: () => {
        attempts.count += 1
        return attempts.count === 1 ? firstAuth.promise : { userId: "UNEW" }
      },
    })
    const eventSource = new LeucoMemorySlackEventSource()
    const stopSource = vi.spyOn(eventSource, "stop")
    const connector = new LeucoSlackConnector({
      eventSource,
      webClient,
      ackMode: "off",
    })
    const oldEvents = new LeucoEventLog()
    const newEvents = new LeucoEventLog()
    const oldTurn = vi.fn(async () => "")
    const newTurn = vi.fn(async () => "")
    const oldStart = connector
      .start({
        eventLog: oldEvents,
        onLog: () => {},
        runTextTurn: oldTurn,
      })
      .catch((error: unknown) => error)
    try {
      await connector.stop()
      await connector.start({
        eventLog: newEvents,
        onLog: () => {},
        runTextTurn: newTurn,
      })
      const stopCount = stopSource.mock.calls.length
      if (outcome === "resolved") firstAuth.resolve({ userId: "UOLD" })
      else firstAuth.reject(new Error("old auth rejected"))
      expect(await oldStart).toBeInstanceOf(Error)
      expect(eventSource.status()).toBe("connected")
      expect(stopSource).toHaveBeenCalledTimes(stopCount)
      expect(connector.getIdentity().botUserId).toBe("UNEW")
      await eventSource.emit({
        type: "events_api",
        receivedAt: 1000,
        payload: {
          event: {
            type: "message",
            channel: "C1",
            user: "UHUMAN",
            text: "<@UNEW> hello",
            ts: "1.0",
          },
        },
      })
      expect(newTurn).toHaveBeenCalledOnce()
      expect(oldTurn).not.toHaveBeenCalled()
    } finally {
      firstAuth.resolve({ userId: "UOLD" })
      await oldStart
      await connector.stop()
      oldEvents.close()
      newEvents.close()
    }
  },
)
