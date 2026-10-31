import { beforeEach, expect, it, vi } from "vitest"
import { inspectDiagnosticHistory } from "@/cli/inspect-diagnostic-history"

const fixture = vi.hoisted(() => ({ inspect: vi.fn(), read: vi.fn() }))
vi.mock("node:fs", () => ({ lstatSync: fixture.inspect }))
vi.mock("@/events/read-leuco-events", () => ({ readLeucoEvents: fixture.read }))
beforeEach(() => {
  fixture.inspect.mockReset().mockReturnValue(undefined)
  fixture.read.mockReset().mockReturnValue([])
})

it("does not call a missing database valid when the live daemon reports SQLite", () => {
  const history = inspectDiagnosticHistory("/memory", {
    running: true,
    runtime: { logs: { mode: "sqlite" } },
  })
  expect(history.eventLogValid).toBe(false)
  expect(history.eventLogPresent).toBe(false)
  expect(history.failures).toMatchObject([
    {
      phase: "event-log",
      causes: [expect.objectContaining({ message: expect.stringContaining("missing") })],
    },
  ])
  expect(fixture.read).not.toHaveBeenCalled()
})
it.each([
  undefined,
  { running: false },
  { running: true, runtime: { logs: { mode: "memory-fallback" } } },
])("allows an absent database without a live SQLite claim (%j)", (status) => {
  expect(inspectDiagnosticHistory("/memory", status)).toMatchObject({
    eventLogValid: true,
    errors: [],
    recentFailures: [],
  })
  expect(fixture.read).not.toHaveBeenCalled()
})
it("still reads existing history with failure filtering", () => {
  fixture.inspect.mockReturnValue({})
  expect(
    inspectDiagnosticHistory("/memory", { running: true, runtime: { logs: { mode: "sqlite" } } })
      .eventLogValid,
  ).toBe(true)
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith("/memory/events.db", 10, {
    failuresOnly: true,
  })
})
