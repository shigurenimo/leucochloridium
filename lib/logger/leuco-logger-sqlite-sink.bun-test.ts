import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { LeucoLoggerSqliteSink } from "@/logger/leuco-logger-sqlite-sink"

type Event = { type: string; payload: string }

describe("LeucoLoggerSqliteSink", () => {
  let tmp: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "leuco-logger-"))
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns 0 from getMaxSeq on a fresh database", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    expect(sink.getMaxSeq()).toBe(0)
    sink.close()
  })

  it("insert assigns seq via SQLite rowid and reads back via getRecords", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    const a = sink.insert({ ts: 100, event: { type: "hello", payload: "a" } })
    const b = sink.insert({ ts: 200, event: { type: "bye", payload: "b" } })

    if (a instanceof Error || b instanceof Error) throw new Error("unexpected")
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)

    const all = sink.getRecords()
    expect(all.map((r) => r.seq)).toEqual([1, 2])
    expect(all[0]?.event).toEqual({ type: "hello", payload: "a" })
    expect(all[0]?.ts).toBe(100)
    expect(sink.getMaxSeq()).toBe(2)

    sink.close()
  })

  it("filters by event.type", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    sink.insert({ ts: 1, event: { type: "hello", payload: "a" } })
    sink.insert({ ts: 2, event: { type: "bye", payload: "b" } })
    sink.insert({ ts: 3, event: { type: "hello", payload: "c" } })

    const hellos = sink.getRecords({ type: "hello" })
    expect(hellos.map((r) => r.seq)).toEqual([1, 3])

    sink.close()
  })

  it("filters by sinceSeq for replay", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    sink.insert({ ts: 1, event: { type: "x", payload: "a" } })
    sink.insert({ ts: 2, event: { type: "x", payload: "b" } })
    sink.insert({ ts: 3, event: { type: "x", payload: "c" } })

    const recent = sink.getRecords({ sinceSeq: 1 })
    expect(recent.map((r) => r.seq)).toEqual([2, 3])

    sink.close()
  })

  it("respects limit", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    for (const i of [1, 2, 3, 4, 5]) {
      sink.insert({ ts: i, event: { type: "x", payload: String(i) } })
    }

    const page = sink.getRecords({ limit: 2 })
    expect(page.map((r) => r.seq)).toEqual([1, 2])

    sink.close()
  })

  it("trims oldest rows when maxRows is exceeded", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:", maxRows: 3 })
    for (const i of [1, 2, 3, 4, 5]) {
      sink.insert({ ts: i, event: { type: "x", payload: String(i) } })
    }

    const remaining = sink.getRecords()
    expect(remaining.map((r) => r.seq)).toEqual([3, 4, 5])
    expect(sink.getMaxSeq()).toBe(5)

    sink.close()
  })

  it("trims rows older than maxAgeMs on every insert", () => {
    let now = 1000
    const sink = new LeucoLoggerSqliteSink<Event>({
      path: ":memory:",
      maxAgeMs: 100,
      now: () => now,
    })

    sink.insert({ ts: 900, event: { type: "x", payload: "old" } })
    sink.insert({ ts: 950, event: { type: "x", payload: "still-old" } })
    sink.insert({ ts: 1000, event: { type: "x", payload: "fresh" } })

    now = 1200
    sink.insert({ ts: 1200, event: { type: "x", payload: "newest" } })

    const remaining = sink.getRecords()
    expect(remaining.map((r) => r.event.payload)).toEqual(["newest"])

    sink.close()
  })

  it("insertMany writes in a single transaction and assigns contiguous seq", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    const result = sink.insertMany([
      { ts: 1, event: { type: "x", payload: "a" } },
      { ts: 2, event: { type: "x", payload: "b" } },
      { ts: 3, event: { type: "x", payload: "c" } },
    ])

    if (result instanceof Error) throw new Error("unexpected")
    expect(result.map((r) => r.seq)).toEqual([1, 2, 3])
    expect(sink.getMaxSeq()).toBe(3)

    sink.close()
  })

  it("insertMany returns [] for an empty batch without touching the database", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    const result = sink.insertMany([])

    expect(Array.isArray(result) && result.length === 0).toBe(true)
    expect(sink.getMaxSeq()).toBe(0)

    sink.close()
  })

  it("write accepts a pre-assigned seq for replication scenarios", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    const outcome = sink.write({ seq: 100, ts: 1, event: { type: "x", payload: "a" } })

    expect(outcome).toBeUndefined()
    expect(sink.getMaxSeq()).toBe(100)

    const next = sink.insert({ ts: 2, event: { type: "x", payload: "b" } })
    if (next instanceof Error) throw new Error("unexpected")
    expect(next.seq).toBe(101)

    sink.close()
  })

  it("write returns Error on seq collision", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    sink.insert({ ts: 1, event: { type: "x", payload: "a" } })
    const outcome = sink.write({ seq: 1, ts: 2, event: { type: "x", payload: "dup" } })

    expect(outcome instanceof Error).toBe(true)

    sink.close()
  })

  it("two sinks against the same file see one monotonically increasing seq stream", () => {
    const path = join(tmp, "shared.db")
    const a = new LeucoLoggerSqliteSink<Event>({ path })
    const b = new LeucoLoggerSqliteSink<Event>({ path })

    const r1 = a.insert({ ts: 1, event: { type: "x", payload: "a1" } })
    const r2 = b.insert({ ts: 2, event: { type: "x", payload: "b1" } })
    const r3 = a.insert({ ts: 3, event: { type: "x", payload: "a2" } })
    const r4 = b.insert({ ts: 4, event: { type: "x", payload: "b2" } })

    if (r1 instanceof Error || r2 instanceof Error || r3 instanceof Error || r4 instanceof Error) {
      throw new Error("unexpected")
    }
    expect([r1.seq, r2.seq, r3.seq, r4.seq]).toEqual([1, 2, 3, 4])
    expect(a.getMaxSeq()).toBe(4)
    expect(b.getMaxSeq()).toBe(4)

    a.close()
    b.close()
  })

  it("survives a reopen with the same file: getMaxSeq returns the persisted value", () => {
    const path = join(tmp, "reopen.db")
    const first = new LeucoLoggerSqliteSink<Event>({ path })
    first.insert({ ts: 1, event: { type: "x", payload: "a" } })
    first.insert({ ts: 2, event: { type: "x", payload: "b" } })
    first.close()

    const second = new LeucoLoggerSqliteSink<Event>({ path })
    expect(second.getMaxSeq()).toBe(2)
    const next = second.insert({ ts: 3, event: { type: "x", payload: "c" } })
    if (next instanceof Error) throw new Error("unexpected")
    expect(next.seq).toBe(3)
    second.close()
  })

  it("migrate advances PRAGMA user_version to the latest schema", () => {
    const sink = new LeucoLoggerSqliteSink<Event>({ path: ":memory:" })
    expect(sink.getSchemaVersion()).toBe(1)
    sink.close()
  })

  it("indexes: store and filter by caller-defined columns", () => {
    type ChannelEvent = { type: string; channel_id: string; connector_id: string }
    const sink = new LeucoLoggerSqliteSink<ChannelEvent, ["channel_id", "connector_id"]>({
      path: ":memory:",
      indexes: ["channel_id", "connector_id"],
      extractIndexes: (e) => ({
        channel_id: e.channel_id,
        connector_id: e.connector_id,
      }),
    })

    sink.insert({ ts: 1, event: { type: "msg", channel_id: "c1", connector_id: "k1" } })
    sink.insert({ ts: 2, event: { type: "msg", channel_id: "c1", connector_id: "k2" } })
    sink.insert({ ts: 3, event: { type: "msg", channel_id: "c2", connector_id: "k1" } })

    const c1Only = sink.getRecords({ where: { channel_id: "c1" } })
    expect(c1Only.map((r) => r.seq)).toEqual([1, 2])

    const c1k2 = sink.getRecords({ where: { channel_id: "c1", connector_id: "k2" } })
    expect(c1k2.map((r) => r.seq)).toEqual([2])

    sink.close()
  })

  it("indexes: combine where with sinceSeq, type, and limit", () => {
    type Ev = { type: string; channel_id: string }
    const sink = new LeucoLoggerSqliteSink<Ev, ["channel_id"]>({
      path: ":memory:",
      indexes: ["channel_id"],
      extractIndexes: (e) => ({ channel_id: e.channel_id }),
    })

    for (const i of [1, 2, 3, 4, 5]) {
      sink.insert({ ts: i, event: { type: "x", channel_id: i % 2 === 0 ? "c1" : "c2" } })
    }

    const filtered = sink.getRecords({
      sinceSeq: 1,
      type: "x",
      where: { channel_id: "c1" },
      limit: 10,
    })
    expect(filtered.map((r) => r.seq)).toEqual([2, 4])

    sink.close()
  })

  it("indexes: where supports IS NULL via explicit null value", () => {
    type Ev = { type: string; channel_id: string | null }
    const sink = new LeucoLoggerSqliteSink<Ev, ["channel_id"]>({
      path: ":memory:",
      indexes: ["channel_id"],
      extractIndexes: (e) => ({ channel_id: e.channel_id }),
    })

    sink.insert({ ts: 1, event: { type: "x", channel_id: "c1" } })
    sink.insert({ ts: 2, event: { type: "x", channel_id: null } })

    const nulls = sink.getRecords({ where: { channel_id: null } })
    expect(nulls.map((r) => r.seq)).toEqual([2])

    sink.close()
  })

  it("indexes: rejects invalid column name (SQL injection guard)", () => {
    type Ev = { type: string }
    expect(() => {
      new LeucoLoggerSqliteSink<Ev, ["bad name; DROP TABLE leuco_log"]>({
        path: ":memory:",
        indexes: ["bad name; DROP TABLE leuco_log"],
        extractIndexes: () => ({ "bad name; DROP TABLE leuco_log": null }),
      })
    }).toThrow(/invalid index column name/)
  })

  it("indexes: rejects reserved column names", () => {
    type Ev = { type: string }
    expect(() => {
      new LeucoLoggerSqliteSink<Ev, ["seq"]>({
        path: ":memory:",
        indexes: ["seq"],
        extractIndexes: () => ({ seq: null }),
      })
    }).toThrow(/reserved index column name/)
  })

  it("indexes: ALTER TABLE adds a new column when reopening with extra index", () => {
    type Ev = { type: string; channel_id: string }
    const path = join(tmp, "indexes.db")

    const first = new LeucoLoggerSqliteSink<Ev>({ path })
    first.insert({ ts: 1, event: { type: "x", channel_id: "c1" } })
    first.close()

    const second = new LeucoLoggerSqliteSink<Ev, ["channel_id"]>({
      path,
      indexes: ["channel_id"],
      extractIndexes: (e) => ({ channel_id: e.channel_id }),
    })
    second.insert({ ts: 2, event: { type: "x", channel_id: "c2" } })

    const filtered = second.getRecords({ where: { channel_id: "c2" } })
    expect(filtered.map((r) => r.seq)).toEqual([2])

    const all = second.getRecords()
    expect(all.length).toBe(2)
    expect(all[0]?.event).toEqual({ type: "x", channel_id: "c1" })

    second.close()
  })
})
