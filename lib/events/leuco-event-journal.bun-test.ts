import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { LeucoEventJournal } from "@/events/leuco-event-journal"

describe("LeucoEventJournal", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-event-journal-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("records events in memory when no path is configured", () => {
    const journal = new LeucoEventJournal()

    journal.log("info", "hello")
    journal.log("warn", "world")

    expect(journal.query().map((entry) => entry.event)).toEqual([
      expect.objectContaining({ type: "log", line: "hello" }),
      expect.objectContaining({ type: "log", line: "world" }),
    ])
  })

  test("persists events to SQLite", () => {
    const path = join(dir, "events.db")
    const journal = new LeucoEventJournal({ eventLogPath: path })

    journal.log("info", "one")
    journal.log("warn", "two")

    const entries = journal.query()

    expect(entries).toHaveLength(2)
    expect(entries[0]!.event).toMatchObject({ type: "log", line: "one" })
    expect(entries[1]!.event).toMatchObject({ type: "log", line: "two" })

    journal.close()
  })

  test("indexes the project column", () => {
    const path = join(dir, "events.db")
    const journal = new LeucoEventJournal({ eventLogPath: path })

    journal.append({ ts: Date.now(), type: "runtime.started", project: "alpha" })
    journal.append({ ts: Date.now(), type: "runtime.started", project: "beta" })
    journal.append({ ts: Date.now(), type: "log", level: "info", line: "no project" })

    const alphaOnly = journal.query({ project: "alpha" })

    expect(alphaOnly).toHaveLength(1)
    expect(alphaOnly[0]!.event).toMatchObject({ type: "runtime.started", project: "alpha" })

    journal.close()
  })

  test("retains only the configured number of newest rows", () => {
    const path = join(dir, "events.db")
    const journal = new LeucoEventJournal({ eventLogPath: path, maxRows: 2 })

    journal.log("info", "one")
    journal.log("info", "two")
    journal.log("info", "three")

    expect(journal.query().map((entry) => entry.event)).toEqual([
      expect.objectContaining({ type: "log", line: "two" }),
      expect.objectContaining({ type: "log", line: "three" }),
    ])
    journal.close()
  })

  test("bounds large turn and notification payloads on disk", () => {
    const path = join(dir, "events.db")
    const journal = new LeucoEventJournal({ eventLogPath: path })
    const large = "x".repeat(40_000)

    journal.append({
      ts: Date.now(),
      type: "turn.complete",
      project: "demo",
      threadKey: "thread",
      reply: large,
    })
    journal.append({
      ts: Date.now(),
      type: "codex.notification",
      project: "demo",
      method: "item/commandExecution/outputDelta",
      params: { delta: large },
    })

    const [turn, notification] = journal.query().map((entry) => entry.event)
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
    journal.close()
  })

  test("close is idempotent", () => {
    const journal = new LeucoEventJournal({ eventLogPath: join(dir, "events.db") })
    journal.close()
    journal.close()
  })
})
