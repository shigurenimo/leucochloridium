import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { LeucoEventLog } from "@/events/leuco-event-log"

const fixture = vi.hoisted(() => ({ construct: vi.fn(), write: vi.fn() }))
vi.mock("@/node-diagnostic-output", () => ({
  NodeDiagnosticOutput: class {
    constructor() {
      fixture.construct()
    }
    write = fixture.write
  },
}))
beforeEach(() => {
  fixture.construct.mockReset()
  fixture.write.mockReset().mockResolvedValue(undefined)
  vi.spyOn(MemoryEventLog.prototype, "insert").mockImplementationOnce(() => {
    throw Object.assign(new Error("store failed"), { code: "EIO" })
  })
})
afterEach(() => vi.restoreAllMocks())
it.each([true, false])(
  "preserves persistence health with explicit quiet output (%s)",
  async (quiet) => {
    const log = new LeucoEventLog(quiet ? { diagnosticOutput: null } : {})
    log.log("error", "entry")
    expect(log.getHealth()).toMatchObject({
      failedWrites: 1,
      lastWriteFailed: true,
      lastPersistError: {
        causes: expect.arrayContaining([expect.objectContaining({ code: "EIO" })]),
      },
    })
    expect(fixture.construct).toHaveBeenCalledTimes(quiet ? 0 : 1)
    expect(fixture.write).toHaveBeenCalledTimes(quiet ? 0 : 1)
    await Promise.resolve()
    log.close()
  },
)
