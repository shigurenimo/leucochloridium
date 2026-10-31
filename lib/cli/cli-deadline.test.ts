import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CliDeadline } from "@/cli/cli-deadline"
vi.mock("@/cli/write-cli-error", () => ({ writeCliError: vi.fn(async () => {}) }))

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
it("stops execution observation before output completion without marking a timeout", async () => {
  const deadline = new CliDeadline(["status", "--timeout-ms", "25"], "output-request")
  deadline.stopObservation()
  await vi.advanceTimersByTimeAsync(25)
  expect(deadline.expired).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it("preserves an expired command's forced-exit budget while observing output", async () => {
  const deadline = new CliDeadline(["status", "--timeout-ms", "25"], "output-request")
  await vi.advanceTimersByTimeAsync(25)
  expect(deadline.expired).toBe(true)
  deadline.stopObservation()
  expect(vi.getTimerCount()).toBe(1)
  deadline.finish()
  expect(vi.getTimerCount()).toBe(0)
})
it.each([
  ["--version", "--json", "--yaml"],
  ["--version", "--version"],
  ["--version", "-v"],
  ["--version", "--json", "--json"],
  ["-v", "--yaml", "--yaml"],
])("rejects conflicting or duplicate version flags %j", (...args) => {
  expect(() => new CliDeadline(args, "version-request")).toThrow()
  expect(vi.getTimerCount()).toBe(0)
})
it.each([["--version"], ["-v", "--yaml"], ["--json", "--version"]])(
  "keeps valid version requests independent of execution deadlines %j",
  (...args) => {
    const deadline = new CliDeadline(args, "version-request")
    expect(vi.getTimerCount()).toBe(0)
    expect(deadline.controller.signal.aborted).toBe(false)
    deadline.finish()
  },
)
