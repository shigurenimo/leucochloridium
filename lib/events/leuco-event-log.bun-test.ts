import { Database } from "bun:sqlite"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { SqliteEventLog } from "@/event-log/sqlite-event-log"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { maintainLeucoEventLog } from "@/events/maintain-leuco-event-log"

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

describe("maintainLeucoEventLog", () => {
  const dayMs = 24 * 60 * 60 * 1_000
  const now = 100 * dayMs
  const maxBytes = 512 * 1_024
  const targetBytes = 384 * 1_024

  type Props = {
    path: string
    expiredRows: number
    recentRows: number
  }

  function seedEventDatabase(props: Props): void {
    new LeucoEventLog({ eventLogPath: props.path }).close()
    const database = new Database(props.path)
    try {
      const insert = database.query("INSERT INTO logs (ts, type, event) VALUES (?, ?, ?)")
      const event = JSON.stringify({ type: "log", level: "info", line: "x".repeat(1_000) })
      database.transaction(() => {
        for (const index of Array.from({ length: props.expiredRows }).keys())
          insert.run(now - 2 * dayMs - index, "log", event)
        for (const index of Array.from({ length: props.recentRows }).keys())
          insert.run(now - 1_000 + index, "log", event)
      })()
    } finally {
      database.close()
    }
  }

  function readDatabaseSize(path: string): { rows: number; bytes: number } {
    const database = new Database(path, { readonly: true })
    try {
      const rows = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM logs").get()
      const pages = database.query<{ page_count: number }, []>("PRAGMA page_count").get()
      const pageSize = database.query<{ page_size: number }, []>("PRAGMA page_size").get()
      return {
        rows: rows?.count ?? 0,
        bytes: (pages?.page_count ?? 0) * (pageSize?.page_size ?? 0),
      }
    } finally {
      database.close()
    }
  }

  function maintain(path: string): void {
    maintainLeucoEventLog({
      path,
      maxRows: 100_000,
      maxAgeMs: dayMs,
      maxBytes,
      targetBytes,
      now: () => now,
    })
  }

  test("does not count pages freed by expired rows as bytes of the remaining rows", () => {
    const workspace = mkdtempSync(join(tmpdir(), "leuco-event-maintenance-"))
    try {
      const path = join(workspace, "events.db")
      seedEventDatabase({ path, expiredRows: 2_000, recentRows: 200 })
      expect(readDatabaseSize(path).bytes).toBeGreaterThan(maxBytes)

      maintain(path)

      const size = readDatabaseSize(path)
      expect(size.rows).toBe(200)
      expect(size.bytes).toBeLessThanOrEqual(maxBytes)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test("drops only enough of the oldest retained rows to reach the byte target", () => {
    const workspace = mkdtempSync(join(tmpdir(), "leuco-event-maintenance-"))
    try {
      const path = join(workspace, "events.db")
      seedEventDatabase({ path, expiredRows: 2_000, recentRows: 1_000 })

      maintain(path)

      const size = readDatabaseSize(path)
      expect(size.bytes).toBeLessThanOrEqual(maxBytes)
      expect(size.rows).toBeGreaterThan(250)
      expect(size.rows).toBeLessThan(330)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
