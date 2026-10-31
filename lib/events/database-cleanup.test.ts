import { beforeEach, expect, it, vi } from "vitest"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { maintainLeucoEventLog } from "@/events/maintain-leuco-event-log"
import { errorDetails } from "@/error-details"
const fixture = vi.hoisted(() => ({
  rows: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
}))
vi.mock("node:fs", () => ({ statSync: () => ({ isFile: () => true }) }))
vi.mock("bun:sqlite", () => ({
  Database: class {
    constructor(...args: unknown[]) {
      fixture.open(...args)
    }
    query() {
      return { all: fixture.rows }
    }
    prepare() {
      return { get: fixture.get, run: fixture.run }
    }
    run = fixture.run
    close = fixture.close
  },
}))
beforeEach(() => {
  fixture.rows.mockReset().mockReturnValue([
    {
      seq: 1,
      ts: 1,
      event: JSON.stringify({ ts: 1, type: "runtime.started", runtime: "leuco" }),
    },
  ])
  fixture.get.mockReset().mockReturnValue({ name: "logs" })
  fixture.run.mockReset()
  fixture.close.mockReset()
  fixture.open.mockReset()
})
it("retains query and close failures when reading saved history", () => {
  fixture.rows.mockImplementationOnce(() => {
    throw Object.assign(new Error("read failed"), { code: "EIO" })
  })
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EBUSY" })
  })
  const failure = (() => {
    try {
      return readLeucoEvents("/memory/events.db", 10)
    } catch (error) {
      return error
    }
  })()
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EIO", "EBUSY"]),
  )
  expect(fixture.close).toHaveBeenCalledOnce()
})
it("does not replace malformed saved JSON with a close error", () => {
  fixture.rows.mockReturnValue([{ seq: 1, ts: 1, event: "invalid JSON" }])
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EIO" })
  })
  const failure = (() => {
    try {
      return readLeucoEvents("/memory/events.db", 10)
    } catch (error) {
      return error
    }
  })()
  expect(errorDetails(failure).some((cause) => cause.name === "SyntaxError")).toBe(true)
  expect(errorDetails(failure).some((cause) => cause.code === "EIO")).toBe(true)
})
it("keeps a retention failure and its close failure together", () => {
  fixture.get.mockImplementationOnce(() => {
    throw Object.assign(new Error("database locked"), { code: "SQLITE_BUSY" })
  })
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EIO" })
  })
  const failure = (() => {
    try {
      return maintainLeucoEventLog({
        path: "/memory/events.db",
        maxRows: 100,
        maxAgeMs: 1000,
        maxBytes: 1000,
        targetBytes: 500,
        now: () => 100,
      })
    } catch (error) {
      return error
    }
  })()
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["SQLITE_BUSY", "EIO"]),
  )
  expect(fixture.close).toHaveBeenCalledOnce()
})
it("does not claim successful history after close failed on an otherwise successful query", () => {
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EIO" })
  })
  expect(() => readLeucoEvents("/memory/events.db", 10)).toThrow("close failed")
})
it("keeps successful reads read-only and closes exactly once", () => {
  expect(readLeucoEvents("/memory/events.db", 10)).toEqual([
    { seq: 1, ts: 1, event: { ts: 1, type: "runtime.started", runtime: "leuco" } },
  ])
  expect(fixture.open).toHaveBeenCalledExactlyOnceWith("/memory/events.db", { readonly: true })
  expect(fixture.close).toHaveBeenCalledOnce()
  expect(fixture.run).toHaveBeenCalledExactlyOnceWith("PRAGMA busy_timeout = 250")
})

it("closes after read timeout setup fails and retains a simultaneous close failure", () => {
  fixture.run.mockImplementationOnce(() => {
    throw Object.assign(new Error("timeout setup failed"), { code: "SQLITE_ERROR" })
  })
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed"), { code: "EIO" })
  })
  const failure = (() => {
    try {
      return readLeucoEvents("/memory/events.db", 10)
    } catch (error) {
      return error
    }
  })()
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["SQLITE_ERROR", "EIO"]),
  )
  expect(fixture.rows).not.toHaveBeenCalled()
  expect(fixture.close).toHaveBeenCalledOnce()
})

it.each([
  ["runtime.started", ["runtime.started", "tenant.started"]],
  ["runtime.stopped", ["runtime.stopped", "tenant.stopped"]],
  ["supervisor.reconcile", ["supervisor.reconcile", "engine.reconcile"]],
  ["supervisor.reconcile.failed", ["supervisor.reconcile.failed", "engine.reconcile.failed"]],
  ["turn.rejected", ["turn.rejected"]],
])("includes stored aliases for the %s type filter", (type, aliases) => {
  readLeucoEvents("/memory/events.db", 7, { type, requestId: "wanted", since: 10 })
  expect(fixture.rows).toHaveBeenCalledExactlyOnceWith("wanted", ...aliases, 10, 7)
  expect(fixture.close).toHaveBeenCalledOnce()
})

it.each(["xoxb-synthetic\\u002dreader-tail", "\\u0078app-synthetic-reader-tail"])(
  "masks complete decoded tokens in stored JSON: %s",
  (encodedToken) => {
    fixture.rows.mockReturnValue([
      {
        seq: 7,
        ts: 1,
        event: `{"ts":1,"type":"log","level":"warn","line":"token ${encodedToken}"}`,
      },
    ])
    expect(readLeucoEvents("/memory/events.db", 10)[0]?.event).toMatchObject({
      type: "log",
      line: "token [redacted]",
    })
    expect(fixture.close).toHaveBeenCalledOnce()
  },
)

it("identifies malformed stored JSON without quoting its contents", () => {
  const encoded = '{"line":"xoxb-synthetic-malformed-secret'
  fixture.rows.mockReturnValue([{ seq: 73, ts: 1, event: encoded }])
  const error = (() => {
    try {
      readLeucoEvents("/memory/events.db", 10)
    } catch (failure) {
      return failure
    }
  })()
  expect(error).toBeInstanceOf(SyntaxError)
  expect(error).toMatchObject({
    message: `Stored event JSON is invalid (sequence 73; ${encoded.length} characters)`,
  })
  expect(fixture.close).toHaveBeenCalledOnce()
})
