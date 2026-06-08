import { mkdtempSync, readFileSync, rmSync } from "node:fs"
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

  test("appends every event to the configured log path on stop", async () => {
    const path = join(dir, "events.jsonl")
    const bus = new LeucoEventBus({ eventLogPath: path })

    bus.log("info", "one")
    bus.log("warn", "two")
    await bus.stop()

    const lines = readFileSync(path, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "log", line: "one" })
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "log", line: "two" })
  })

  test("creates the log directory when it does not exist", async () => {
    const path = join(dir, "nested", "events.jsonl")
    const bus = new LeucoEventBus({ eventLogPath: path })

    bus.log("info", "hi")
    await bus.stop()

    expect(readFileSync(path, "utf8")).toContain('"line":"hi"')
  })

  test("stop is idempotent when no events were emitted", async () => {
    const bus = new LeucoEventBus({ eventLogPath: join(dir, "events.jsonl") })
    await bus.stop()
    await bus.stop()
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
