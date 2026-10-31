import { expect, it, vi } from "vitest"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoMemorySlackEventSource } from "@/connectors/slack/leuco-memory-slack-event-source"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { errorDetails } from "@/error-details"

it.each([false, true])(
  "keeps the startup error and optional cleanup failure (%s)",
  async (cleanupFails) => {
    const primary = Object.assign(new Error("startup callback failed"), { code: "ESTART" })
    const cleanup = Object.assign(new Error("socket close failed"), { code: "ECLOSE" })
    const eventSource = new LeucoMemorySlackEventSource()
    if (cleanupFails) vi.spyOn(eventSource, "stop").mockRejectedValueOnce(cleanup)
    const connector = new LeucoSlackConnector({
      eventSource,
      webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
    })
    const eventLog = new LeucoEventLog()
    try {
      const failure = await connector
        .start({
          eventLog,
          onLog: (line) => {
            if (line.includes("ready — forwarding")) throw primary
          },
          runTextTurn: async () => "",
        })
        .catch((error: unknown) => error)
      if (!cleanupFails) expect(failure).toBe(primary)
      else {
        expect(failure).toBeInstanceOf(AggregateError)
        expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] })
        const codes = errorDetails(failure).map((cause) => cause.code)
        expect(codes).toContain("ESTART")
        expect(codes).toContain("ECLOSE")
      }
      expect(connector.getIdentity().botUserId).toBeNull()
    } finally {
      await connector.stop()
      eventLog.close()
    }
  },
)

it("drains accepted work before returning combined startup and close failures", async () => {
  const primary = new Error("startup failed after accepting a message")
  const cleanup = new Error("close failed while work was active")
  const eventSource = new LeucoMemorySlackEventSource()
  const closing = Promise.withResolvers<void>()
  const stopSource = vi.spyOn(eventSource, "stop").mockImplementationOnce(async () => {
    closing.resolve()
    throw cleanup
  })
  const connector = new LeucoSlackConnector({
    eventSource,
    webClient: new LeucoMemorySlackWebClient({ authTest: { userId: "UBOT" } }),
    ackMode: "off",
  })
  const eventLog = new LeucoEventLog()
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<string>()
  const observed: { settled: boolean; traffic: Promise<void> | null } = {
    settled: false,
    traffic: null,
  }
  const starting = connector
    .start({
      eventLog,
      onLog: (line) => {
        if (!line.includes("ready — forwarding")) return
        observed.traffic = eventSource.emit({
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
        throw primary
      },
      runTextTurn: () => {
        entered.resolve()
        return finish.promise
      },
    })
    .catch((error: unknown) => {
      observed.settled = true
      return error
    })
  try {
    await entered.promise
    await closing.promise
    expect(stopSource).toHaveBeenCalledOnce()
    expect(observed.settled).toBe(false)
    finish.resolve("")
    expect(await starting).toMatchObject({ cause: primary, errors: [primary, cleanup] })
    expect(observed.settled).toBe(true)
    expect(connector.getIdentity().botUserId).toBeNull()
  } finally {
    finish.resolve("")
    await starting
    await observed.traffic
    await connector.stop()
    eventLog.close()
  }
})
