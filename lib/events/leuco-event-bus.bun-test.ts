import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { LeucoEventBus } from "@/events/leuco-event-bus"

describe("LeucoEventBus", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-event-bus-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("fans events out to live subscribers", () => {
    const bus = new LeucoEventBus()
    const received: string[] = []
    bus.subscribe((event) => {
      if (event.type === "log") received.push(event.line)
    })

    bus.log("info", "hello")
    bus.log("warn", "world")

    expect(received).toEqual(["hello", "world"])
  })

  test("subscribe returns an unsubscribe handle", () => {
    const bus = new LeucoEventBus()
    let count = 0
    const off = bus.subscribe(() => {
      count++
    })

    bus.log("info", "first")
    off()
    bus.log("info", "second")

    expect(count).toBe(1)
  })

  test("persists events to SQLite", () => {
    const path = join(dir, "events.db")
    const bus = new LeucoEventBus({ eventLogPath: path })

    bus.log("info", "one")
    bus.log("warn", "two")

    const sink = bus.getSink()!
    const entries = sink.query()

    expect(entries).toHaveLength(2)
    expect(entries[0]!.event).toMatchObject({ type: "log", line: "one" })
    expect(entries[1]!.event).toMatchObject({ type: "log", line: "two" })

    bus.stop()
  })

  test("indexes the project column", () => {
    const path = join(dir, "events.db")
    const bus = new LeucoEventBus({ eventLogPath: path })

    bus.emit({ ts: Date.now(), type: "tenant.started", project: "alpha" })
    bus.emit({ ts: Date.now(), type: "tenant.started", project: "beta" })
    bus.emit({ ts: Date.now(), type: "log", level: "info", line: "no project" })

    const sink = bus.getSink()!
    const alphaOnly = sink.query({ where: { project: "alpha" } })

    expect(alphaOnly).toHaveLength(1)
    expect(alphaOnly[0]!.event).toMatchObject({ type: "tenant.started", project: "alpha" })

    bus.stop()
  })

  test("stop is idempotent", () => {
    const bus = new LeucoEventBus({ eventLogPath: join(dir, "events.db") })
    bus.stop()
    bus.stop()
  })

  test("a failing subscriber does not block other subscribers", () => {
    const bus = new LeucoEventBus()
    const received: string[] = []
    bus.subscribe(() => {
      throw new Error("boom")
    })
    bus.subscribe((event) => {
      if (event.type === "log") received.push(event.line)
    })

    bus.log("info", "kept going")

    expect(received).toEqual(["kept going"])
  })
})
