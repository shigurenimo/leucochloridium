import { Database } from "bun:sqlite"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { SqliteEventLog } from "@/event-log/sqlite-event-log"
import { LeucoEventLog } from "@/events/leuco-event-log"

describe("LeucoEventLog", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-event-log-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("records events in memory when no path is configured", () => {
    const eventLog = new LeucoEventLog()

    eventLog.log("info", "hello")
    eventLog.log("warn", "world")

    expect(eventLog.query().map((entry) => entry.event)).toEqual([
      expect.objectContaining({ type: "log", line: "hello" }),
      expect.objectContaining({ type: "log", line: "world" }),
    ])
  })

  test("persists events to SQLite and leaves stored reads to readLeucoEvents", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path })

    eventLog.log("info", "one")
    eventLog.log("warn", "two")

    const entries = readLeucoEvents(path, 10)

    expect(entries).toHaveLength(2)
    expect(entries[0]!.event).toMatchObject({ type: "log", line: "two" })
    expect(entries[1]!.event).toMatchObject({ type: "log", line: "one" })
    expect(() => eventLog.query()).toThrow("readLeucoEvents")

    eventLog.close()
  })

  test("retains only the configured number of newest rows", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path, maxRows: 2 })

    eventLog.log("info", "one")
    eventLog.log("info", "two")
    eventLog.log("info", "three")

    expect(readLeucoEvents(path, 10).map((entry) => entry.event)).toEqual([
      expect.objectContaining({ type: "log", line: "three" }),
      expect.objectContaining({ type: "log", line: "two" }),
    ])
    eventLog.close()
  })

  test("trims SQLite rows when the live database exceeds its byte cap", () => {
    const eventLog = new SqliteEventLog<{ type: string; body: string }>({
      path: join(dir, "bounded.db"),
      maxBytes: 64 * 1024,
      targetBytes: 32 * 1024,
    })

    for (let index = 0; index < 500; index++) {
      const inserted = eventLog.insert({
        ts: index,
        event: { type: "large", body: "x".repeat(2_048) },
      })
      expect(inserted).not.toBeInstanceOf(Error)
    }

    expect(eventLog.query({ limit: 1_000 }).length).toBeLessThan(500)
    eventLog.close()
  })

  test("bounds large turn payloads on disk", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path })
    const large = "x".repeat(40_000)

    eventLog.append({
      ts: Date.now(),
      type: "turn.complete",
      threadKey: "thread",
      reply: large,
    })

    const turn = readLeucoEvents(path, 10)[0]?.event
    expect(turn).toMatchObject({
      type: "turn.complete",
      replyChars: 40_000,
      replyTruncated: true,
    })
    if (turn?.type === "turn.complete") expect(turn.reply.length).toBe(16_000)
    eventLog.close()
  })

  test("masks decoded legacy JSON tokens without changing stored rows", () => {
    const path = join(dir, "escaped-legacy.db")
    const seeded = new LeucoEventLog({ eventLogPath: path })
    seeded.log("warn", "placeholder")
    seeded.close()
    const database = new Database(path)
    const encoded =
      '{"ts":1,"type":"log","level":"warn","line":"token xoxb-synthetic\\u002dreader-tail"}'
    try {
      database.query("UPDATE logs SET event = ?").run(encoded)
      expect(readLeucoEvents(path, 10)[0]?.event).toMatchObject({
        type: "log",
        line: "token [redacted]",
      })
      expect(database.query("SELECT event FROM logs").get()).toMatchObject({ event: encoded })
    } finally {
      database.close()
    }
  })

  test("close is idempotent", () => {
    const eventLog = new LeucoEventLog({ eventLogPath: join(dir, "events.db") })
    eventLog.close()
    eventLog.close()
  })
})
