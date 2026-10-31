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

  test("filters normalized legacy event types before applying the limit", () => {
    const path = join(dir, "legacy-runtime.db")
    const legacy = new SqliteEventLog<
      { ts: number; type: "tenant.started"; project: string },
      ["runtime"]
    >({ path, indexes: ["runtime"], extractIndexes: () => ({ runtime: null }) })
    legacy.insert({
      ts: Date.now(),
      event: { ts: Date.now(), type: "tenant.started", project: "alpha" },
    })
    legacy.close()
    const saved = new LeucoEventLog({ eventLogPath: path })
    const memory = new LeucoEventLog()
    memory.append({ ts: Date.now(), type: "runtime.started", runtime: "alpha" })
    try {
      for (const index of Array.from({ length: 20 }).keys()) {
        saved.append({ ts: Date.now() + index, type: "runtime.stopped", runtime: "beta" })
        memory.append({ ts: Date.now() + index, type: "runtime.stopped", runtime: "beta" })
      }
      for (const order of ["asc", "desc"] satisfies Array<"asc" | "desc">) {
        const query = { type: "runtime.started", limit: 1, order }
        expect(saved.query(query).map((entry) => entry.seq)).toEqual(
          memory.query(query).map((entry) => entry.seq),
        )
        expect(saved.query(query)[0]?.event).toMatchObject({
          type: "runtime.started",
          runtime: "alpha",
        })
      }
    } finally {
      saved.close()
      memory.close()
    }
  })

  test("persists events to SQLite", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path })

    eventLog.log("info", "one")
    eventLog.log("warn", "two")

    const entries = eventLog.query()

    expect(entries).toHaveLength(2)
    expect(entries[0]!.event).toMatchObject({ type: "log", line: "one" })
    expect(entries[1]!.event).toMatchObject({ type: "log", line: "two" })

    eventLog.close()
  })

  test("reads pre-0.17 event names and connector fields", () => {
    const path = join(dir, "events.db")
    const legacyLog = new SqliteEventLog<
      | { ts: number; type: "tenant.started"; runtime: string }
      | {
          ts: number
          type: "slack.error"
          runtime: string
          channel: string
          level: "error"
          action: string
          message: string
          error: null
        },
      ["runtime"]
    >({
      path,
      indexes: ["runtime"],
      extractIndexes: (event) => ({ runtime: event.runtime }),
    })
    legacyLog.insert({
      ts: 1700000000000,
      event: {
        ts: 1700000000000,
        type: "tenant.started",
        runtime: "demo",
      },
    })
    legacyLog.insert({
      ts: 1700000000001,
      event: {
        ts: 1700000000001,
        type: "slack.error",
        runtime: "demo",
        channel: "slack",
        level: "error",
        action: "turn.failed",
        message: "failed",
        error: null,
      },
    })
    legacyLog.close()

    const eventLog = new LeucoEventLog({
      eventLogPath: path,
      now: () => 1700000001000,
    })

    expect(eventLog.query({ type: "runtime.started" })).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "runtime.started",
          runtime: "demo",
        }),
      }),
    ])
    expect(eventLog.query({ type: "slack.error" })).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          type: "slack.error",
          connector: "slack",
        }),
      }),
    ])
    eventLog.close()
  })

  test("retains only the configured number of newest rows", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path, maxRows: 2 })

    eventLog.log("info", "one")
    eventLog.log("info", "two")
    eventLog.log("info", "three")

    expect(eventLog.query().map((entry) => entry.event)).toEqual([
      expect.objectContaining({ type: "log", line: "two" }),
      expect.objectContaining({ type: "log", line: "three" }),
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

  test("bounds large turn and notification payloads on disk", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path })
    const large = "x".repeat(40_000)

    eventLog.append({
      ts: Date.now(),
      type: "turn.complete",
      runtime: "demo",
      threadKey: "thread",
      reply: large,
    })
    eventLog.append({
      ts: Date.now(),
      type: "codex.notification",
      runtime: "demo",
      method: "item/commandExecution/outputDelta",
      params: { delta: large },
    })

    const [turn, notification] = eventLog.query().map((entry) => entry.event)
    expect(turn).toMatchObject({
      type: "turn.complete",
      replyChars: 40_000,
      replyTruncated: true,
    })
    if (turn?.type === "turn.complete") expect(turn.reply.length).toBe(16_000)
    if (notification?.type === "codex.notification") {
      expect(notification.params).toMatchObject({
        truncated: true,
        originalChars: expect.any(Number),
      })
    }
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
