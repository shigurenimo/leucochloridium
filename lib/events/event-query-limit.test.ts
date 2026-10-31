import { expect, it } from "vitest"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each(["asc", "desc"] satisfies Array<"asc" | "desc">)(
  "returns no events for a zero limit in %s order without clearing history",
  (order) => {
    const log = new LeucoEventLog({ diagnosticOutput: null })
    try {
      log.append({ ts: 1, type: "runtime.started", runtime: "leuco" })
      expect(log.query({ limit: 0, order })).toEqual([])
      expect(log.query({ limit: 1, order })).toHaveLength(1)
    } finally {
      log.close()
    }
  },
)

it.each([-1, Number.NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects an invalid event limit %s before selecting history",
  (limit) => {
    const log = new LeucoEventLog({ diagnosticOutput: null })
    try {
      log.append({ ts: 1, type: "runtime.started", runtime: "leuco" })
      for (const order of ["asc", "desc"] satisfies Array<"asc" | "desc">)
        expect(() => log.query({ limit, order })).toThrow(RangeError)
      expect(log.query({ limit: Number.MAX_SAFE_INTEGER })).toHaveLength(1)
    } finally {
      log.close()
    }
  },
)
