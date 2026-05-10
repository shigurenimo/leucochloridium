import { describe, expect, it } from "vitest"
import { z } from "zod"
import { LeucoLogger } from "@/logger/leuco-logger"
import type { LeucoLoggerPrimarySink, LeucoLoggerSink } from "@/logger/leuco-logger-sink"
import { LeucoLoggerMemorySink } from "@/logger/leuco-logger-memory-sink"

const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), name: z.string() }),
  z.object({ type: z.literal("bye"), reason: z.string() }),
])

type Event = z.infer<typeof eventSchema>

describe("LeucoLogger", () => {
  it("delegates seq assignment to the primary sink", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({ schema: eventSchema, primary })

    const first = logger.emit({ type: "hello", name: "ada" })
    const second = logger.emit({ type: "hello", name: "linus" })

    if (first instanceof Error || second instanceof Error) throw new Error("unexpected")
    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(logger.getMaxSeq()).toBe(2)
  })

  it("resumes monotonically when the primary already has records", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    primary.write({ seq: 42, ts: 1, event: { type: "hello", name: "x" } })
    const logger = new LeucoLogger({ schema: eventSchema, primary })

    const next = logger.emit({ type: "bye", reason: "done" })

    if (next instanceof Error) throw new Error("unexpected")
    expect(next.seq).toBe(43)
  })

  it("returns Error and persists nothing when validation fails", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({ schema: eventSchema, primary })

    const bad = { type: "hello" } as unknown as Event
    const outcome = logger.emit(bad)

    expect(outcome instanceof Error).toBe(true)
    expect(primary.getRecords().length).toBe(0)
    expect(logger.getMaxSeq()).toBe(0)
  })

  it("returns Error and skips relays when the primary fails", () => {
    const primary: LeucoLoggerPrimarySink<Event> = {
      insert() {
        return new Error("primary down")
      },
      getMaxSeq: () => 0,
    }
    const relay = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({ schema: eventSchema, primary, relays: [relay] })

    const outcome = logger.emit({ type: "hello", name: "x" })

    expect(outcome instanceof Error).toBe(true)
    expect(relay.getRecords().length).toBe(0)
  })

  it("forwards records to relays in order with the primary's seq", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const a = new LeucoLoggerMemorySink<Event>()
    const b = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({
      schema: eventSchema,
      primary,
      relays: [a, b],
    })

    logger.emit({ type: "hello", name: "x" })
    logger.emit({ type: "bye", reason: "done" })

    expect(a.getRecords().map((r) => r.seq)).toEqual([1, 2])
    expect(b.getRecords().map((r) => r.seq)).toEqual([1, 2])
    expect(primary.getRecords().map((r) => r.seq)).toEqual([1, 2])
  })

  it("isolates a throwing relay so other relays and listeners still receive", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const failing: LeucoLoggerSink<Event> = {
      write() {
        throw new Error("boom")
      },
    }
    const ok = new LeucoLoggerMemorySink<Event>()
    const errors: Error[] = []
    const logger = new LeucoLogger({
      schema: eventSchema,
      primary,
      relays: [failing, ok],
      onSinkError: (error) => errors.push(error),
    })
    const seen: number[] = []
    logger.subscribe((record) => seen.push(record.seq))

    logger.emit({ type: "hello", name: "x" })

    expect(ok.getRecords().length).toBe(1)
    expect(seen).toEqual([1])
    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe("boom")
  })

  it("treats relay-returned Error the same as a thrown one", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const failing: LeucoLoggerSink<Event> = {
      write() {
        return new Error("nope")
      },
    }
    const errors: Error[] = []
    const logger = new LeucoLogger({
      schema: eventSchema,
      primary,
      relays: [failing],
      onSinkError: (error) => errors.push(error),
    })

    logger.emit({ type: "hello", name: "x" })

    expect(errors.length).toBe(1)
    expect(errors[0]?.message).toBe("nope")
  })

  it("isolates a throwing subscriber so emission still completes", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({ schema: eventSchema, primary })
    logger.subscribe(() => {
      throw new Error("listener boom")
    })
    const seen: number[] = []
    logger.subscribe((record) => seen.push(record.seq))

    const outcome = logger.emit({ type: "hello", name: "x" })

    expect(outcome instanceof Error).toBe(false)
    expect(primary.getRecords().length).toBe(1)
    expect(seen).toEqual([1])
  })

  it("stops delivering to a subscriber after unsubscribe", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({ schema: eventSchema, primary })
    const seen: number[] = []
    const off = logger.subscribe((record) => seen.push(record.seq))

    logger.emit({ type: "hello", name: "a" })
    off()
    logger.emit({ type: "hello", name: "b" })

    expect(seen).toEqual([1])
  })

  it("uses the injected clock for ts", () => {
    const primary = new LeucoLoggerMemorySink<Event>()
    const logger = new LeucoLogger({
      schema: eventSchema,
      primary,
      now: () => 1700000000000,
    })

    const outcome = logger.emit({ type: "hello", name: "x" })

    if (outcome instanceof Error) throw new Error("unexpected")
    expect(outcome.ts).toBe(1700000000000)
  })

  it("close clears listeners and calls close on every sink", () => {
    let primaryClosed = false
    let relayClosed = false
    const primary: LeucoLoggerPrimarySink<Event> = {
      insert: (input) => ({ seq: 1, ts: input.ts, event: input.event }),
      getMaxSeq: () => 0,
      close: () => {
        primaryClosed = true
      },
    }
    const relay: LeucoLoggerSink<Event> = {
      write: () => {},
      close: () => {
        relayClosed = true
      },
    }
    const logger = new LeucoLogger({ schema: eventSchema, primary, relays: [relay] })
    const seen: number[] = []
    logger.subscribe((r) => seen.push(r.seq))

    logger.close()
    logger.emit({ type: "hello", name: "x" })

    expect(primaryClosed).toBe(true)
    expect(relayClosed).toBe(true)
    expect(seen.length).toBe(0)
  })
})
