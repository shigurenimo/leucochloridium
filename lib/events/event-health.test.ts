import { afterEach, describe, expect, it, vi } from "vitest"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { MemoryEventLog } from "@/event-log/memory-event-log"
afterEach(() => vi.restoreAllMocks())
describe("observable log persistence", () => {
  it("exposes a failed sink without crashing and records recovery and actual retention settings", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw new Error("disk full xoxb-sensitive-token")
    })
    const log = new LeucoEventLog({ maxRows: 3 })
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
    vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const log = new LeucoEventLog()
    expect(() => log.append({ ts: NaN, type: "runtime.started", runtime: "leuco" })).not.toThrow()
    expect(log.getHealth().lastWriteFailed).toBe(true)
    expect(log.getHealth().lastPersistError?.message).toContain("serialization")
    log.log("info", "next valid event")
    expect(log.getHealth().lastWriteFailed).toBe(false)
    log.close()
  })

  it("redacts nested causes and sends failed writes to the fallback sink", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
      throw new Error("sink unavailable")
    })
    const fallback = vi.fn()
    const log = new LeucoEventLog({ onFallback: fallback })
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
