import { beforeEach, expect, it, vi } from "vitest"
import { createDaemonStartupError } from "@/daemon/create-daemon-startup-error"

const fixture = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("@/fs/read-regular-text", () => ({ readRegularText: fixture.read }))
beforeEach(() => {
  fixture.read.mockReset()
})
it("does not follow a replaced startup log and retains the child failure", () => {
  fixture.read.mockImplementation(
    (_path: string, _limit?: number, options?: { followSymlinks?: boolean }) => {
      if (options?.followSymlinks === false)
        throw new Error("Refusing to read a symbolic link as local data")
      return "private-target-sentinel"
    },
  )
  const spawnError = Object.assign(new Error("child spawn failed"), { code: "EPIPE" })
  const failure = createDaemonStartupError({
    home: "/memory",
    pid: 42,
    exitCode: 1,
    signal: null,
    spawnError,
  })
  expect(failure.details).toMatchObject({
    pid: 42,
    exitCode: 1,
    logTail: "",
    logTailTruncated: null,
    logReadFailure: [{ message: "Refusing to read a symbolic link as local data" }],
    causes: [{ code: "EPIPE" }],
  })
  expect(JSON.stringify(failure.details)).not.toContain("private-target-sentinel")
})
it("preserves a log read failure separately from the observed child exit", () => {
  fixture.read.mockImplementation(() => {
    throw Object.assign(new Error("log permission denied"), { code: "EACCES" })
  })
  const failure = createDaemonStartupError({
    home: "/memory",
    pid: 42,
    exitCode: null,
    signal: "SIGTERM",
    spawnError: null,
  })
  expect(failure.details).toMatchObject({
    pid: 42,
    exitCode: null,
    signal: "SIGTERM",
    logTail: "",
    logTailTruncated: null,
    logReadFailure: [{ code: "EACCES" }],
  })
})

it.each([
  { text: "起動失敗 😀", expected: "起動失敗 😀", truncated: false },
  { text: `prefix😀${"x".repeat(15999)}`, expected: "x".repeat(15999), truncated: true },
  { text: `prefix${"x".repeat(15998)}😀`, expected: `${"x".repeat(15998)}😀`, truncated: true },
  {
    text: `prefix xoxb-synthetic-startup-token ${"x".repeat(15980)}`,
    expected: `prefix [redacted] ${"x".repeat(15980)}`,
    truncated: false,
  },
])("preserves Unicode and reports startup log clipping ($truncated)", (probe) => {
  fixture.read.mockReturnValue(probe.text)
  const failure = createDaemonStartupError({
    home: "/memory",
    pid: 42,
    exitCode: 1,
    signal: null,
    spawnError: null,
  })
  expect(failure.details).toMatchObject({
    logTail: probe.expected,
    logTailTruncated: probe.truncated,
    logReadFailure: null,
  })
  expect(probe.expected.length).toBeLessThanOrEqual(16000)
})
