import { expect, it } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"

it.each([false, true])(
  "records one schedule read failure (text sink fails: %s)",
  async (sinkFails) => {
    const events = new LeucoEventLog()
    const secret = "synthetic-schedule-diagnostic-secret"
    events.addRedactionSecrets([secret])
    const failure = Object.assign(new Error(`settings unavailable ${secret}`), { code: "EACCES" })
    const connector = new LeucoScheduleConnector({
      store: {
        listEntries: () => {
          throw failure
        },
        getLastAttempt: () => null,
        markFired: () => {},
        removeEntry: () => false,
      },
    })
    const text: Array<{ line: string; level: string | undefined }> = []
    const codex = new MemoryCodexClient()
    const runtime = LeucoRuntime.build({
      store: new MemoryLeucoStore(),
      codex,
      eventLog: events,
      env: {},
      connections: [connector],
      onLog: (line, level) => {
        text.push({ line, level })
        if (sinkFails && line.includes("failed to read entries"))
          throw new Error("text sink failed")
      },
    })
    try {
      await runtime.start()
      await connector.waitForStartupTick()
      const failures = events
        .query({ type: "log" })
        .filter(
          (entry) =>
            entry.event.type === "log" && entry.event.line.includes("settings unavailable"),
        )
      expect(failures).toHaveLength(1)
      expect(failures[0]?.event).toMatchObject({
        level: "error",
        line: "[schedule] failed to read entries: settings unavailable [redacted]",
        causes: [expect.objectContaining({ code: "EACCES" })],
      })
      expect(text.filter((entry) => entry.line.includes("settings unavailable"))).toEqual([
        {
          line: "[schedule] failed to read entries: settings unavailable [redacted]",
          level: "error",
        },
      ])
      expect(JSON.stringify(failures)).not.toContain(secret)
      expect(runtime.getStatus().logConsumer.healthy).toBe(!sinkFails)
      expect(codex.turns).toEqual([])
      expect(failure.message).toContain(secret)
    } finally {
      await runtime.stop()
      events.close()
    }
  },
)
