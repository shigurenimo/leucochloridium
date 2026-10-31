import { expect, it } from "vitest"
import { LeucoEventLog } from "@/events/leuco-event-log"

it.each(["maxRows", "maxAgeMs", "maxBytes", "targetBytes"])(
  "rejects invalid retention %s before creating a store",
  (key) => {
    for (const value of [-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => new LeucoEventLog({ diagnosticOutput: null, [key]: value })).toThrow(RangeError)
  },
)

it("keeps the default shrink target within a smaller byte cap", () => {
  const log = new LeucoEventLog({ diagnosticOutput: null, maxBytes: 1024 })
  try {
    expect(log.getHealth().retention).toMatchObject({ maxBytes: 1024, targetBytes: 768 })
  } finally {
    log.close()
  }
})

it.each([{ maxBytes: 0 }, { maxBytes: 1024, targetBytes: 1025 }])(
  "rejects an unusable byte retention policy: %j",
  (policy) => {
    expect(() => new LeucoEventLog({ diagnosticOutput: null, ...policy })).toThrow(RangeError)
  },
)

it("permits zero row retention and a zero shrink target", () => {
  const log = new LeucoEventLog({
    diagnosticOutput: null,
    maxRows: 0,
    maxAgeMs: 0,
    maxBytes: 1,
    targetBytes: 0,
  })
  try {
    log.log("info", "not retained")
    expect(log.query()).toEqual([])
  } finally {
    log.close()
  }
})
