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
      | { ts: number; type: "tenant.started"; project: string }
      | {
          ts: number
          type: "slack.error"
          project: string
          channel: string
          level: "error"
          action: string
          message: string
          error: null
        },
      ["project"]
    >({
      path,
      indexes: ["project"],
      extractIndexes: (event) => ({ project: event.project }),
    })
    legacyLog.insert({
      ts: 1700000000000,
      event: {
        ts: 1700000000000,
        type: "tenant.started",
        project: "demo",
      },
    })
    legacyLog.insert({
      ts: 1700000000001,
      event: {
        ts: 1700000000001,
        type: "slack.error",
        project: "demo",
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
          project: "demo",
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

  test("indexes the project column", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path })

    eventLog.append({ ts: Date.now(), type: "runtime.started", project: "alpha" })
    eventLog.append({ ts: Date.now(), type: "runtime.started", project: "beta" })
    eventLog.append({ ts: Date.now(), type: "log", level: "info", line: "no project" })

    const alphaOnly = eventLog.query({ project: "alpha" })

    expect(alphaOnly).toHaveLength(1)
    expect(alphaOnly[0]!.event).toMatchObject({ type: "runtime.started", project: "alpha" })

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

  test("bounds large turn and notification payloads on disk", () => {
    const path = join(dir, "events.db")
    const eventLog = new LeucoEventLog({ eventLogPath: path })
    const large = "x".repeat(40_000)

    eventLog.append({
      ts: Date.now(),
      type: "turn.complete",
      project: "demo",
      threadKey: "thread",
      reply: large,
    })
    eventLog.append({
      ts: Date.now(),
      type: "codex.notification",
      project: "demo",
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

  test("close is idempotent", () => {
    const eventLog = new LeucoEventLog({ eventLogPath: join(dir, "events.db") })
    eventLog.close()
    eventLog.close()
  })
})
