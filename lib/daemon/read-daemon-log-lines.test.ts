import { beforeEach, expect, it, vi } from "vitest"
import { readDaemonLogLines } from "@/daemon/read-daemon-log-lines"

const fixture = vi.hoisted(() => ({ inspect: vi.fn(), read: vi.fn() }))
vi.mock("node:fs", () => ({ existsSync: () => false, lstatSync: fixture.inspect }))
vi.mock("@/fs/read-regular-text", () => ({ readRegularText: fixture.read }))
beforeEach(() => {
  fixture.inspect.mockReset().mockReturnValue(undefined)
  fixture.read.mockReset()
})
it("does not report empty logs when path inspection is denied", () => {
  fixture.inspect.mockImplementation(() => {
    throw Object.assign(new Error("cannot inspect log"), { code: "EACCES" })
  })
  expect(() => readDaemonLogLines("/memory", 10)).toThrow("cannot inspect log")
  expect(fixture.read).not.toHaveBeenCalled()
})
it("does not skip an existing broken log link", () => {
  fixture.inspect.mockReturnValueOnce({})
  fixture.read.mockImplementation(() => {
    throw new Error("Refusing to read a symbolic link as local data")
  })
  expect(() => readDaemonLogLines("/memory", 10)).toThrow("symbolic link")
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith("/memory/daemon.log", 16 * 1024 * 1024, {
    followSymlinks: false,
  })
})
it("allows absent generations and does not inspect older files once the requested tail is full", () => {
  expect(readDaemonLogLines("/memory", 1)).toEqual([])
  fixture.inspect
    .mockReset()
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce({})
    .mockImplementation(() => {
      throw new Error("older generation must not be inspected")
    })
  fixture.read.mockReturnValue("latest available\n")
  expect(readDaemonLogLines("/memory", 1)).toEqual(["latest available"])
  expect(fixture.inspect).toHaveBeenCalledTimes(2)
})

it.each(["inspect", "read"])("retains readable current logs when an older %s fails", (mode) => {
  const original = Object.assign(new Error("older log denied"), { code: "EACCES" })
  fixture.inspect.mockReturnValue({})
  fixture.read.mockReturnValueOnce("latest xoxb-synthetic-private-token\n")
  if (mode === "inspect")
    fixture.inspect.mockReturnValueOnce({}).mockImplementation(() => {
      throw original
    })
  else
    fixture.read.mockImplementation(() => {
      throw original
    })
  const failure = (() => {
    try {
      readDaemonLogLines("/memory", 10)
    } catch (error) {
      return error
    }
  })()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    cause: original,
    details: {
      phase: "log-read",
      generation: "daemon.log.1",
      historyComplete: false,
      savedLines: ["latest [redacted]"],
      causes: [expect.objectContaining({ code: "EACCES", message: "older log denied" })],
    },
  })
})
