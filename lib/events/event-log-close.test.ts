import { beforeEach, expect, it, vi } from "vitest"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { LeucoEventLog } from "@/events/leuco-event-log"

const fixture = vi.hoisted(() => ({ close: vi.fn() }))
vi.mock("node:fs", () => ({ existsSync: () => false, statSync: () => ({ isFile: () => true }) }))
vi.mock("@/events/maintain-leuco-event-log", () => ({ maintainLeucoEventLog: () => {} }))
vi.mock("@/event-log/sqlite-event-log", async () => {
  const memory = await import("@/event-log/memory-event-log")
  return {
    SqliteEventLog: class extends memory.MemoryEventLog<LeucoEvent> {
      close() {
        fixture.close()
      }
    },
  }
})
beforeEach(() => fixture.close.mockReset())

it("does not report closed or discard redaction after a store close failure", () => {
  fixture.close.mockImplementationOnce(() => {
    throw Object.assign(new Error("close failed synthetic-close-secret"), { code: "EBUSY" })
  })
  const log = new LeucoEventLog({
    eventLogPath: "/memory/events.db",
  })
  log.addRedactionSecrets(["synthetic-close-secret"])
  expect(() => log.close()).toThrow("close failed")
  expect(log.getHealth().closed).toBe(false)
  const failure = log.getHealth().lastCloseError
  expect(failure?.causes).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "EBUSY" })]),
  )
  expect(JSON.stringify(failure)).not.toContain("synthetic-close-secret")
  const snapshot = log.getHealth()
  snapshot.lastCloseError!.causes[0]!.message = "caller mutation"
  expect(log.getHealth().lastCloseError).toEqual(failure)
  log.log("warn", "after failed close synthetic-close-secret", "after-close")
  expect(JSON.stringify(log.query({ requestId: "after-close" }))).not.toContain(
    "synthetic-close-secret",
  )
  log.close()
  expect(log.getHealth().closed).toBe(true)
  expect(log.getHealth().lastCloseError).toEqual(failure)
  expect(fixture.close).toHaveBeenCalledTimes(2)
  log.close()
  expect(fixture.close).toHaveBeenCalledTimes(2)
})
