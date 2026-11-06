import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { CliDeadline } from "@/cli/cli-deadline"
import { parseCliInvocation } from "@/cli/parse-cli-invocation"
vi.mock("@/cli/write-cli-error", () => ({ writeCliError: vi.fn(async () => {}) }))

function createDeadline(args: string[], requestId: string) {
  return new CliDeadline(parseCliInvocation(args), args, requestId)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
it("stops execution observation before output completion without marking a timeout", async () => {
  const deadline = createDeadline(["status", "--timeout-ms", "25"], "output-request")
  deadline.stopObservation()
  await vi.advanceTimersByTimeAsync(25)
  expect(deadline.expired).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it("preserves an expired command's forced-exit budget while observing output", async () => {
  const deadline = createDeadline(["status", "--timeout-ms", "25"], "output-request")
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
  expect(() => createDeadline(args, "version-request")).toThrow()
  expect(vi.getTimerCount()).toBe(0)
})
it.each([["--version"], ["-v", "--yaml"], ["--json", "--version"]])(
  "keeps valid version requests independent of execution deadlines %j",
  (...args) => {
    const deadline = createDeadline(args, "version-request")
    expect(vi.getTimerCount()).toBe(0)
    expect(deadline.controller.signal.aborted).toBe(false)
    deadline.finish()
  },
)
it.each([
  ["--help", "--timeout-ms", "25"],
  ["run", "--foreground"],
])("starts no deadline for help or foreground runs without a timeout %j", (...args) => {
  const deadline = createDeadline(args, "untimed-request")
  expect(vi.getTimerCount()).toBe(0)
  deadline.finish()
})
