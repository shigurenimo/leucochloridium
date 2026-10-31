import { beforeEach, expect, it, vi } from "vitest"
import { readBoundedUploadFile } from "@/actions/slack/read-bounded-upload-file"
import { errorDetails } from "@/error-details"

const fixture = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
  chunks: vi.fn(),
  close: vi.fn(),
}))
vi.mock("node:fs/promises", () => ({ open: fixture.open }))
beforeEach(() => {
  fixture.open.mockReset().mockResolvedValue({
    stat: fixture.stat,
    createReadStream: fixture.chunks,
    close: fixture.close,
  })
  fixture.stat.mockReset().mockResolvedValue({ isFile: () => true, size: 1 })
  fixture.chunks.mockReset().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([42])
    },
  })
  fixture.close
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("close failed"), { code: "EBUSY" }))
})
it.each(["stat", "read"])("retains %s failure alongside close failure", async (phase) => {
  const primary = Object.assign(new Error("primary read failed"), { code: "EIO" })
  if (phase === "stat") fixture.stat.mockRejectedValue(primary)
  else
    fixture.chunks.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        throw primary
      },
    })
  const failure = await readBoundedUploadFile({ path: "/memory/upload", maxBytes: 10 }).catch(
    (error: unknown) => error,
  )
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EIO", "EBUSY"]),
  )
  expect(failure).toMatchObject({ cause: primary })
  expect(fixture.close).toHaveBeenCalledOnce()
})
it("does not return upload bytes after close failed", async () => {
  await expect(
    readBoundedUploadFile({ path: "/memory/upload", maxBytes: 10 }),
  ).rejects.toMatchObject({ code: "EBUSY" })
  expect(fixture.close).toHaveBeenCalledOnce()
})
it("returns bounded bytes after confirmed cleanup", async () => {
  fixture.close.mockResolvedValue(undefined)
  const upload = await readBoundedUploadFile({ path: "/memory/upload", maxBytes: 10 })
  expect(Array.from(upload.content)).toEqual([42])
  expect(upload).toMatchObject({ exceedsLimit: false, isFile: true })
  expect(fixture.close).toHaveBeenCalledOnce()
})
