import { beforeEach, expect, it, vi } from "vitest"
import { parseArguments } from "@/cli/parse-arguments"
import { requestSlackCommand } from "@/cli/request-slack-command"

const fixture = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn() }))
vi.mock("@/actions/slack/read-bounded-upload-file", () => ({ readBoundedUploadFile: fixture.read }))
vi.mock("@/daemon/request-daemon", () => ({ requestDaemon: fixture.request }))
beforeEach(() => {
  fixture.read.mockReset()
  fixture.request.mockReset().mockResolvedValue({ fileId: "F1" })
})

const upload = parseArguments(["slack", "upload-file", "--channel", "C1", "--file", "/memory/f"])

it.each([
  ["missing", () => Promise.reject(Object.assign(new Error("no such file"), { code: "ENOENT" }))],
  ["non-regular", () => Promise.resolve({ exceedsLimit: false, isFile: false })],
  ["oversized", () => Promise.resolve({ exceedsLimit: true, isFile: true })],
])("rejects a %s upload file as USAGE before contacting the daemon", async (_label, read) => {
  fixture.read.mockImplementation(read)
  await expect(
    requestSlackCommand("/memory/home", upload, { requestId: "request" }),
  ).rejects.toMatchObject({
    code: "USAGE",
    details: { phase: "validation", parameter: "file", executionStarted: false },
  })
  expect(fixture.request).not.toHaveBeenCalled()
})

it("keeps the original failure for unclassified local read errors", async () => {
  const failure = Object.assign(new Error("device failed"), { code: "EIO" })
  fixture.read.mockRejectedValue(failure)
  await expect(requestSlackCommand("/memory/home", upload, { requestId: "request" })).rejects.toBe(
    failure,
  )
  expect(fixture.request).not.toHaveBeenCalled()
})

it("retains the open failure as cause", async () => {
  const failure = Object.assign(new Error("permission denied"), { code: "EACCES" })
  fixture.read.mockRejectedValue(failure)
  await expect(
    requestSlackCommand("/memory/home", upload, { requestId: "request" }),
  ).rejects.toMatchObject({
    cause: failure,
    details: { causes: [expect.objectContaining({ code: "EACCES" })] },
  })
})
