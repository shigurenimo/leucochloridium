import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { appendDaemonLog } from "@/daemon/append-daemon-log"
import { DaemonTextLog } from "@/daemon/daemon-text-log"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { errorDetails } from "@/error-details"

vi.mock("@/daemon/append-daemon-log", () => ({ appendDaemonLog: vi.fn() }))
const diagnosticOutput = new MemoryDiagnosticOutput()
beforeEach(() => {
  diagnosticOutput.attempts.length = 0
  diagnosticOutput.failure = null
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.mocked(appendDaemonLog).mockReset()
})

it("retains OS causes and masks tokens in the diagnostic snapshot", () => {
  const failure = Object.assign(new Error("Cannot append xoxb-sensitive-token"), { code: "EACCES" })
  vi.mocked(appendDaemonLog).mockImplementationOnce(() => {
    throw failure
  })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  expect(log.write("line")).toBe(failure)
  const health = log.getHealth()
  expect(health.healthy).toBe(false)
  expect(health.lastFailure?.causes[0]?.code).toBe("EACCES")
  expect(JSON.stringify(health)).not.toContain("sensitive-token")
  expect(diagnosticOutput.attempts[0]).not.toContain("sensitive-token")
  health.lastFailure!.causes[0]!.message = "caller mutation"
  expect(log.getHealth().lastFailure?.causes[0]?.message).not.toBe("caller mutation")
})

it("retains the last failure after successful recovery", () => {
  vi.mocked(appendDaemonLog).mockImplementationOnce(() => {
    throw new Error("disk full")
  })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  log.write("failed")
  const failed = log.getHealth()
  expect(log.write("recovered")).toBeNull()
  expect(log.getHealth()).toEqual({ ...failed, healthy: true })
})

it("marks shortened persistence failures without breaking Unicode", () => {
  vi.mocked(appendDaemonLog).mockImplementationOnce(() => {
    throw new Error(`${"a".repeat(3987)}😀${"z".repeat(100)}`)
  })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  log.write("failed")
  const message = log.getHealth().lastFailure?.message
  expect(message).toHaveLength(3999)
  expect(message?.endsWith(" [truncated]")).toBe(true)
  expect(message?.isWellFormed()).toBe(true)
})

it("preserves write, close and diagnostic reporting failures together", () => {
  const write = new Error("write failed")
  const close = new Error("close failed")
  vi.mocked(appendDaemonLog).mockImplementationOnce(() => {
    throw new AggregateError([write, close], "write and close failed", { cause: write })
  })
  vi.spyOn(diagnosticOutput, "write").mockImplementation(() => {
    throw new Error("stderr closed")
  })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  const failure = log.write("line")
  const messages = errorDetails(failure).map((cause) => cause.message)
  expect(messages).toEqual(
    expect.arrayContaining(["write failed", "close failed", "stderr closed"]),
  )
  expect(log.getHealth().lastFailure?.causes.map((cause) => cause.message)).toEqual(messages)
})

it("keeps delayed reporting tied to its original failure after newer writes and recovery", async () => {
  const pending = Promise.withResolvers<void>()
  vi.spyOn(diagnosticOutput, "write").mockReturnValueOnce(pending.promise)
  vi.mocked(appendDaemonLog)
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("first failure"), { code: "EACCES" })
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("second failure"), { code: "ENOSPC" })
    })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  log.write("first")
  log.write("second")
  log.write("recovered")
  pending.reject(Object.assign(new Error("closed xoxb-sensitive-report-token"), { code: "EPIPE" }))
  await vi.waitFor(() => expect(log.getHealth().lastReportError).not.toBeNull())
  const health = log.getHealth()
  expect(health.healthy).toBe(true)
  expect(health.lastFailure?.causes).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "ENOSPC" })]),
  )
  expect(health.lastFailure?.causes.some((cause) => cause.code === "EPIPE")).toBe(false)
  expect(health.lastReportError?.causes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "EACCES" }),
      expect.objectContaining({ code: "EPIPE" }),
    ]),
  )
  expect(JSON.stringify(health)).not.toContain("sensitive-report-token")
  health.lastReportError!.causes[0]!.message = "caller mutation"
  expect(JSON.stringify(log.getHealth())).not.toContain("caller mutation")
  expect(diagnosticOutput.write).toHaveBeenCalledOnce()
})
it("bounds stalled reporting and permits a later report without wall-clock dependence", async () => {
  vi.useFakeTimers()
  const output = vi.spyOn(diagnosticOutput, "write").mockReturnValueOnce(new Promise(() => {}))
  vi.mocked(appendDaemonLog).mockImplementation(() => {
    throw new Error("disk full")
  })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  log.write("failed")
  await vi.advanceTimersByTimeAsync(1000)
  expect(log.getHealth().lastReportError?.causes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("timed out after 1000ms") }),
    ]),
  )
  vi.setSystemTime(Date.now() - 3600000)
  log.write("rate limited")
  expect(output).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60001)
  log.write("next report")
  expect(output).toHaveBeenCalledTimes(2)
})

it("keeps persistence-error reporting on one physical line with Unicode controls escaped", () => {
  vi.mocked(appendDaemonLog).mockImplementationOnce(() => {
    throw new Error("failed\nforged\u001b[31m\u0085\u2028\u2029")
  })
  const log = new DaemonTextLog({ home: "/not-read", diagnosticOutput })
  log.write("failure")
  const line = diagnosticOutput.attempts[0]!
  expect(line.split("\n")).toHaveLength(2)
  expect(line).not.toMatch(/[\u001b\u0085\u2028\u2029]/u)
  expect(line).toContain("forged")
})
