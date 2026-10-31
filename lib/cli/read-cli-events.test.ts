import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { errorDetails } from "@/error-details"
import { readCliEvents } from "@/cli/read-cli-events"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { requestDaemon } from "@/daemon/request-daemon"

vi.mock("node:fs", () => ({ lstatSync: () => ({}) }))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: () => ({ pid: 42, token: "synthetic-control-token" }),
  isProcessAlive: () => true,
}))
vi.mock("@/daemon/request-daemon", () => ({ requestDaemon: vi.fn() }))
vi.mock("@/events/read-leuco-events", () => ({ readLeucoEvents: vi.fn(() => []) }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requestDaemon).mockReset()
  vi.mocked(readLeucoEvents).mockReset().mockReturnValue([])
})
afterEach(() => vi.restoreAllMocks())

it.each([true, false])(
  "does not claim complete empty history after write loss (currently failing=%s)",
  async (lastWriteFailed) => {
    vi.mocked(requestDaemon).mockResolvedValue({
      runtime: {
        logs: {
          mode: "sqlite",
          failedWrites: 2,
          lastWriteFailed,
          lastPersistError: {
            ts: 100,
            message: "database busy",
            causes: [{ code: "SQLITE_BUSY" }],
          },
        },
      },
    })
    const failed = await readCliEvents({
      home: "/memory",
      requestId: "history-read",
      limit: 10,
      filters: { requestId: "possibly-lost-request" },
    }).catch((error: unknown) => error)
    expect(failed).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: {
        phase: "history-persistence",
        savedEvents: [],
        historyComplete: false,
        persistence: {
          failedWrites: 2,
          lastWriteFailed,
          lastPersistError: { message: "database busy" },
        },
      },
    })
    expect(requestDaemon).toHaveBeenCalledOnce()
  },
)

it("keeps the ordinary array result when no write failures are reported", async () => {
  vi.mocked(requestDaemon).mockResolvedValue({
    runtime: {
      logs: { mode: "sqlite", failedWrites: 0, lastWriteFailed: false, lastPersistError: null },
    },
  })
  expect(
    await readCliEvents({ home: "/memory", requestId: "history-read", limit: 10, filters: {} }),
  ).toEqual([])
})

const volatileEntry = (seq: number) => ({
  seq,
  ts: seq,
  event: { ts: seq, type: "runtime.started", runtime: "leuco", requestId: "wanted" },
})
it.each([
  {
    label: "ascending sequence",
    entries: [volatileEntry(1), volatileEntry(2)],
    limit: 2,
    filters: {},
  },
  {
    label: "duplicate sequence",
    entries: [volatileEntry(2), volatileEntry(2)],
    limit: 2,
    filters: {},
  },
  { label: "ignored limit", entries: [volatileEntry(2), volatileEntry(1)], limit: 1, filters: {} },
  {
    label: "ignored request filter",
    entries: [volatileEntry(2)],
    limit: 2,
    filters: { requestId: "another-request" },
  },
  { label: "ignored time filter", entries: [volatileEntry(1)], limit: 2, filters: { since: 2 } },
  {
    label: "ignored type filter",
    entries: [volatileEntry(2)],
    limit: 2,
    filters: { type: "turn.error" },
  },
  {
    label: "ignored summary filter",
    entries: [{ seq: 2, ts: 2, event: { ts: 2, type: "log", level: "info", line: "noise" } }],
    limit: 2,
    filters: { summary: true },
  },
])("rejects a well-shaped volatile response with $label", async (test) => {
  vi.mocked(requestDaemon)
    .mockResolvedValueOnce({
      runtime: {
        logs: {
          mode: "memory-fallback",
          failedWrites: 1,
          lastWriteFailed: true,
          lastPersistError: {},
        },
      },
    })
    .mockResolvedValueOnce(test.entries)
  const failure = await readCliEvents({
    home: "/memory",
    requestId: "history-read",
    limit: test.limit,
    filters: test.filters,
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "volatile-history", savedEvents: [], historyComplete: false },
  })
})

it("preserves newest-first volatile results that match the query", async () => {
  const entries = [volatileEntry(2), volatileEntry(1)]
  vi.mocked(requestDaemon)
    .mockResolvedValueOnce({
      runtime: {
        logs: {
          mode: "memory-fallback",
          failedWrites: 1,
          lastWriteFailed: true,
          lastPersistError: {},
        },
      },
    })
    .mockResolvedValueOnce(entries)
  expect(
    await readCliEvents({
      home: "/memory",
      requestId: "history-read",
      limit: 2,
      filters: { requestId: "wanted", type: "runtime.started", since: 1, summary: true },
    }),
  ).toEqual(entries)
})

it.each(["sqlite", "memory-fallback"])(
  "retains reporting and close diagnostics when %s history cannot be verified",
  async (mode) => {
    const persistence = {
      mode,
      failedWrites: 2,
      lastWriteFailed: false,
      lastPersistError: { message: "latest database failure", causes: [{ code: "SQLITE_FULL" }] },
      lastReportError: {
        message: "earlier persistence and diagnostic reporting failed",
        causes: [{ code: "SQLITE_BUSY" }, { code: "EPIPE" }],
      },
      lastCloseError: { message: "close failed", causes: [{ code: "EBUSY" }] },
    }
    vi.mocked(requestDaemon)
      .mockResolvedValueOnce({ runtime: { logs: persistence } })
      .mockRejectedValueOnce(new Error("volatile history unreachable"))
    const failure = await readCliEvents({
      home: "/memory",
      requestId: "history-read",
      limit: 10,
      filters: {},
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: {
        phase: mode === "sqlite" ? "history-persistence" : "volatile-history",
        historyComplete: false,
        savedEvents: [],
        persistence,
      },
    })
    expect(requestDaemon).toHaveBeenCalledTimes(mode === "sqlite" ? 1 : 2)
  },
)

it.each(["sqlite", "memory-fallback", "unreachable"])(
  "preserves known diagnostics when saved history also fails (%s)",
  async (mode) => {
    const persistence = {
      mode: mode === "sqlite" ? "sqlite" : "memory-fallback",
      failedWrites: 1,
      lastWriteFailed: true,
      lastPersistError: { message: "database busy", causes: [{ code: "SQLITE_BUSY" }] },
      lastReportError: { message: "stderr closed", causes: [{ code: "EPIPE" }] },
      lastCloseError: null,
    }
    const unavailable = Object.assign(new Error("live unavailable"), { code: "ECONNRESET" })
    if (mode === "unreachable") vi.mocked(requestDaemon).mockRejectedValueOnce(unavailable)
    else
      vi.mocked(requestDaemon)
        .mockResolvedValueOnce({ runtime: { logs: persistence } })
        .mockRejectedValueOnce(unavailable)
    vi.mocked(readLeucoEvents).mockImplementationOnce(() => {
      throw Object.assign(new Error("saved database corrupt"), { code: "SQLITE_NOTADB" })
    })
    const failure = await readCliEvents({
      home: "/memory",
      requestId: "history-read",
      limit: 10,
      filters: {},
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: {
        phase: "saved-history",
        livePhase:
          mode === "sqlite"
            ? "history-persistence"
            : mode === "unreachable"
              ? "control-probe"
              : "volatile-history",
        source: "unavailable",
        liveHistoryVerified: false,
        savedHistoryVerified: false,
        historyComplete: false,
        causes: expect.arrayContaining([expect.objectContaining({ code: "SQLITE_NOTADB" })]),
      },
    })
    if (mode === "unreachable") {
      expect(failure).toMatchObject({
        details: {
          causes: expect.arrayContaining([expect.objectContaining({ code: "ECONNRESET" })]),
        },
      })
    } else expect(failure).toMatchObject({ details: { persistence } })
    expect(failure).not.toHaveProperty("details.savedEvents")
    expect(errorDetails(failure)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SQLITE_NOTADB" })]),
    )
    if (mode !== "sqlite")
      expect(errorDetails(failure)).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "ECONNRESET" })]),
      )
  },
)
