import { describe, expect, it } from "vitest"
import { LeucoLoggerMemorySink } from "@/logger/leuco-logger-memory-sink"

type Event = { type: string; n: number }

describe("LeucoLoggerMemorySink", () => {
  it("returns 0 from getMaxSeq when empty", () => {
    const sink = new LeucoLoggerMemorySink<Event>()
    expect(sink.getMaxSeq()).toBe(0)
  })

  it("insert assigns monotonic seq starting at 1", () => {
    const sink = new LeucoLoggerMemorySink<Event>()

    const a = sink.insert({ ts: 100, event: { type: "x", n: 1 } })
    const b = sink.insert({ ts: 200, event: { type: "x", n: 2 } })

    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(sink.getMaxSeq()).toBe(2)
  })

  it("write accepts pre-assigned seq and bumps the counter", () => {
    const sink = new LeucoLoggerMemorySink<Event>()
    sink.write({ seq: 42, ts: 1, event: { type: "x", n: 1 } })

    const next = sink.insert({ ts: 2, event: { type: "x", n: 2 } })

    expect(next.seq).toBe(43)
  })

  it("retains records in insertion order", () => {
    const sink = new LeucoLoggerMemorySink<Event>()
    sink.insert({ ts: 1, event: { type: "x", n: 1 } })
    sink.insert({ ts: 2, event: { type: "x", n: 2 } })

    expect(sink.getRecords().map((r) => r.seq)).toEqual([1, 2])
  })

  it("evicts the oldest record when capacity is exceeded", () => {
    const sink = new LeucoLoggerMemorySink<Event>({ capacity: 2 })
    sink.insert({ ts: 1, event: { type: "x", n: 1 } })
    sink.insert({ ts: 2, event: { type: "x", n: 2 } })
    sink.insert({ ts: 3, event: { type: "x", n: 3 } })

    expect(sink.getRecords().map((r) => r.seq)).toEqual([2, 3])
    expect(sink.getMaxSeq()).toBe(3)
  })

  it("with capacity 0 retains nothing but still advances seq", () => {
    const sink = new LeucoLoggerMemorySink<Event>({ capacity: 0 })
    const result = sink.insert({ ts: 1, event: { type: "x", n: 1 } })

    expect(result.seq).toBe(1)
    expect(sink.getRecords().length).toBe(0)
    expect(sink.getMaxSeq()).toBe(1)
  })

  it("clear empties the buffer and resets the counter", () => {
    const sink = new LeucoLoggerMemorySink<Event>()
    sink.insert({ ts: 1, event: { type: "x", n: 1 } })
    sink.clear()

    expect(sink.getRecords().length).toBe(0)
    expect(sink.getMaxSeq()).toBe(0)
  })
})
