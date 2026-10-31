import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { MemoryEventLog } from "@/event-log/memory-event-log"
const diagnosticOutput = new MemoryDiagnosticOutput()
beforeEach(() => {
  diagnosticOutput.attempts.length = 0
  diagnosticOutput.failure = null
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe("observable log persistence", () => {
  it.each(["error", "unprintable"])("keeps both the primary and fallback failures (%s)", (kind) => {
    vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw Object.assign(new Error("primary unavailable"), { code: "SQLITE_BUSY" })
    })
    const fallbackFailure =
      kind === "error"
        ? Object.assign(new Error("mirror synthetic-control-token"), { code: "EIO" })
        : Object.create(null)
    const log = new LeucoEventLog({
      diagnosticOutput,
      onFallback: () => {
        throw fallbackFailure
      },
    })
    log.addRedactionSecrets(["synthetic-control-token"])
    expect(() => log.log("error", "failed event")).not.toThrow()
    const failed = log.getHealth()
    expect(failed.lastPersistError?.causes).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SQLITE_BUSY" })]),
    )
    if (kind === "error")
      expect(failed.lastPersistError?.causes).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
      )
    else
      expect(failed.lastPersistError?.causes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "[unprintable thrown value]" }),
        ]),
      )
    expect(JSON.stringify(failed)).not.toContain("synthetic-control-token")
    log.log("info", "recovered event")
    expect(log.getHealth()).toMatchObject({
      lastWriteFailed: false,
      failedWrites: 1,
      successfulWrites: 1,
      lastPersistError: failed.lastPersistError,
    })
    log.close()
  })
  it("keeps primary and stderr failures inspectable without crashing on the reporting error", async () => {
    vi.spyOn(diagnosticOutput, "write").mockImplementationOnce(() => {
      throw Object.assign(new Error("stderr failed"), { code: "EPIPE" })
    })
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw Object.assign(new Error("database busy synthetic-control-token"), {
        code: "SQLITE_BUSY",
      })
    })
    const log = new LeucoEventLog({ diagnosticOutput })
    log.addRedactionSecrets(["synthetic-control-token"])
    expect(() => log.log("error", "failed event")).not.toThrow()
    await vi.waitFor(() =>
      expect(log.getHealth().lastPersistError?.causes.some((cause) => cause.code === "EPIPE")).toBe(
        true,
      ),
    )
    const failed = log.getHealth()
    expect(failed.lastPersistError).toMatchObject({
      causes: expect.arrayContaining([
        expect.objectContaining({ code: "SQLITE_BUSY" }),
        expect.objectContaining({ code: "EPIPE" }),
      ]),
    })
    expect(JSON.stringify(failed)).not.toContain("synthetic-control-token")
    log.log("info", "recovered event")
    expect(log.getHealth()).toMatchObject({
      lastWriteFailed: false,
      failedWrites: 1,
      successfulWrites: 1,
      lastPersistError: failed.lastPersistError,
    })
    if (failed.lastPersistError) failed.lastPersistError.causes[0]!.message = "consumer mutation"
    expect(JSON.stringify(log.getHealth().lastPersistError)).not.toContain("consumer mutation")
    log.close()
  })
  it("associates delayed reporting failure with its original write after recovery and close", async () => {
    const pending = Promise.withResolvers<void>()
    vi.spyOn(diagnosticOutput, "write").mockReturnValueOnce(pending.promise)
    vi.spyOn(MemoryEventLog.prototype, "insert")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("first synthetic-control-token"), { code: "SQLITE_BUSY" })
      })
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("second failure"), { code: "SQLITE_FULL" })
      })
    const log = new LeucoEventLog({ diagnosticOutput })
    log.addRedactionSecrets(["synthetic-control-token"])
    log.log("error", "first")
    log.log("error", "second")
    log.log("info", "recovered")
    log.close()
    pending.reject(Object.assign(new Error("closed synthetic-control-token"), { code: "EPIPE" }))
    await vi.waitFor(() => expect(log.getHealth().lastReportError).not.toBeNull())
    const health = log.getHealth()
    expect(health).toMatchObject({ closed: true, lastWriteFailed: false, failedWrites: 2 })
    expect(health.lastPersistError?.causes).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "SQLITE_FULL" })]),
    )
    expect(health.lastPersistError?.causes.some((cause) => cause.code === "EPIPE")).toBe(false)
    expect(health.lastReportError?.causes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SQLITE_BUSY" }),
        expect.objectContaining({ code: "EPIPE" }),
      ]),
    )
    expect(JSON.stringify(health)).not.toContain("synthetic-control-token")
    if (health.lastReportError) health.lastReportError.causes[0]!.message = "consumer mutation"
    expect(JSON.stringify(log.getHealth())).not.toContain("consumer mutation")
    expect(diagnosticOutput.write).toHaveBeenCalledOnce()
  })
  it("bounds stalled diagnostic reporting without replaying the failed write", async () => {
    vi.useFakeTimers()
    vi.spyOn(diagnosticOutput, "write").mockReturnValueOnce(new Promise(() => {}))
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" })
    })
    const log = new LeucoEventLog({ diagnosticOutput })
    log.log("error", "failed")
    await vi.advanceTimersByTimeAsync(1000)
    expect(log.getHealth().lastReportError?.causes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "SQLITE_BUSY" }),
        expect.objectContaining({ message: expect.stringContaining("timed out after 1000ms") }),
      ]),
    )
    expect(diagnosticOutput.write).toHaveBeenCalledOnce()
    expect(log.getHealth().failedWrites).toBe(1)
    log.close()
  })
  it("keeps persistence error reporting on one physical line", () => {
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw new Error("disk full\nforged line\u001b[31m\u0085\u2028\u2029")
    })
    const log = new LeucoEventLog({ diagnosticOutput })
    log.log("error", "failed event")
    const written = String(stderr.mock.calls[0]?.[0])
    expect(written.split("\n")).toHaveLength(2)
    expect(written).not.toMatch(/[\u001b\u0085\u2028\u2029]/u)
    expect(written).toContain("forged line")
    log.close()
  })
  it("does not suppress reporting indefinitely after wall time moves backwards", async () => {
    vi.useFakeTimers()
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementation(() => {
      throw new Error("database busy")
    })
    const log = new LeucoEventLog({ diagnosticOutput })
    log.log("error", "first failure")
    vi.setSystemTime(Date.now() - 3600000)
    await vi.advanceTimersByTimeAsync(60001)
    log.log("error", "later failure")
    expect(stderr).toHaveBeenCalledTimes(2)
    log.close()
  })
  it("exposes a failed sink without crashing and records recovery and actual retention settings", () => {
    const stderr = vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw new Error("disk full xoxb-sensitive-token")
    })
    const log = new LeucoEventLog({ diagnosticOutput, maxRows: 3 })
    log.setRedactionSecrets(["xoxb-sensitive-token"])
    log.log("error", "first")
    expect(log.getHealth()).toMatchObject({
      failedWrites: 1,
      lastWriteFailed: true,
      successfulWrites: 0,
      retention: { maxRows: 3 },
    })
    expect(log.getHealth().lastPersistError?.message).not.toContain("sensitive-token")
    log.log("info", "second")
    expect(log.getHealth()).toMatchObject({ lastWriteFailed: false, successfulWrites: 1 })
    expect(stderr).toHaveBeenCalledOnce()
    log.close()
  })
  it("contains serialization errors and exposes them instead of breaking the bot", () => {
    vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    const log = new LeucoEventLog({ diagnosticOutput })
    expect(() => log.append({ ts: NaN, type: "runtime.started", runtime: "leuco" })).not.toThrow()
    expect(log.getHealth().lastWriteFailed).toBe(true)
    expect(log.getHealth().lastPersistError?.message).toContain("serialization")
    log.log("info", "next valid event")
    expect(log.getHealth().lastWriteFailed).toBe(false)
    log.close()
  })

  it("redacts nested causes and sends failed writes to the fallback sink", () => {
    vi.spyOn(diagnosticOutput, "write").mockResolvedValue(undefined)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw new Error("sink unavailable")
    })
    const fallback = vi.fn()
    const log = new LeucoEventLog({ diagnosticOutput, onFallback: fallback })
    log.setRedactionSecrets(["arbitrary-secret"])
    log.error(
      "operation failed",
      new Error("arbitrary-secret", { cause: new Error("xoxb-sensitive-token") }),
      "request",
    )
    expect(fallback).toHaveBeenCalledOnce()
    expect(JSON.stringify(fallback.mock.calls)).not.toContain("arbitrary-secret")
    expect(JSON.stringify(fallback.mock.calls)).not.toContain("sensitive-token")
    const health = log.getHealth()
    health.retention.maxRows = 1
    if (health.lastPersistError) health.lastPersistError.message = "mutated"
    expect(log.getHealth().retention.maxRows).toBe(50000)
    expect(log.getHealth().lastPersistError?.message).not.toBe("mutated")
    log.close()
  })
})

it("counts successful writes to an intentionally memory-only store", () => {
  const log = new LeucoEventLog({ diagnosticOutput })
  log.log("info", "first")
  log.log("warn", "second")
  expect(log.getHealth()).toMatchObject({
    mode: "memory",
    durable: false,
    memoryWrites: 2,
    successfulWrites: 2,
    failedWrites: 0,
  })
  log.close()
})
