import { afterEach, expect, it, vi } from "vitest"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoEventLog } from "@/events/leuco-event-log"

afterEach(() => vi.useRealTimers())

for (const withTextMirror of [false, true]) {
  it.each(["read", "mark", "turn", "cleanup"])(
    `bounds and masks the schedule %s failure before callbacks (text mirror: ${withTextMirror})`,
    async (phase) => {
      vi.useFakeTimers()
      vi.setSystemTime(Date.parse("2026-05-07T09:30:00Z"))
      const secret = "synthetic-schedule-private"
      const failure = Object.assign(
        new Error(`${"a".repeat(3950)}${secret}${"z".repeat(100000)}`),
        {
          code: "ESCHEDULE",
          cause: Object.assign(new Error(`storage failed ${secret}`), { code: "EIO" }),
        },
      )
      const events = new LeucoEventLog()
      events.addRedactionSecrets([secret])
      const lines: Array<{
        line: string
        level: string | undefined
        requestId: string | undefined
      }> = []
      const textMirror = vi.fn((line: string, level?: string, requestId?: string) => {
        lines.push({ line, level, requestId })
      })
      const connector = new LeucoScheduleConnector({
        store: {
          listEntries: () => {
            if (phase === "read") throw failure
            return [
              {
                id: "once",
                name: `${"n".repeat(3980)}${secret}${"n".repeat(20000)}`,
                prompt: "run once",
                enabled: true,
                runAt: "2026-05-07T09:00:00Z",
              },
            ]
          },
          getLastAttempt: () => null,
          markFired: () => {
            if (phase === "mark") throw failure
          },
          removeEntry: () => {
            if (phase === "cleanup") throw failure
            return true
          },
        },
      })
      try {
        await connector.start({
          eventLog: events,
          onLog: (line, level, requestId) => {
            lines.push({ line, level, requestId })
          },
          ...(withTextMirror ? { onTextLog: textMirror } : {}),
          runTextTurn: async () => (phase === "turn" ? failure : "done"),
        })
        await connector.waitForStartupTick()
        const diagnostics = lines.filter((entry) => entry.level === "error")
        expect(diagnostics).toHaveLength(1)
        const recorded = events.query({ type: "log" })
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.event).toMatchObject({
          line: diagnostics[0]?.line,
          causes: [
            expect.objectContaining({ code: "ESCHEDULE" }),
            expect.objectContaining({ code: "EIO" }),
          ],
        })
        expect(diagnostics[0]?.line.length).toBeLessThan(4200)
        expect(lines.every((entry) => entry.line.length <= 4000)).toBe(true)
        expect(diagnostics[0]?.line).toContain("[truncated]")
        expect(JSON.stringify({ lines, recorded })).not.toContain(secret)
        expect(textMirror).toHaveBeenCalledTimes(withTextMirror ? 1 : 0)
        if (phase === "turn") {
          expect(diagnostics[0]?.requestId).toEqual(
            events.query({ type: "schedule.fired" })[0]?.event.requestId,
          )
          expect(diagnostics[0]?.requestId).toEqual(expect.any(String))
        }
        expect(failure.message).toContain(secret)
      } finally {
        await connector.stop()
        events.close()
      }
    },
  )
}
