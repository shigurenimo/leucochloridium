import { beforeEach, expect, it, vi } from "vitest"
import { closeSync, openSync } from "node:fs"
import { readRegularText } from "@/fs/read-regular-text"
import { readRegularBytes } from "@/fs/read-regular-bytes"
import { errorDetails } from "@/error-details"

const source = vi.hoisted(
  (): {
    bytes: Uint8Array
    position: number
    reportedSize: number
    chunkLimit: number
    failure: Error | null
  } => ({
    bytes: new Uint8Array(),
    position: 0,
    reportedSize: 0,
    chunkLimit: Number.MAX_SAFE_INTEGER,
    failure: null,
  }),
)
vi.mock("node:fs", () => ({
  constants: { O_RDONLY: 0, O_NONBLOCK: 1, O_NOFOLLOW: 2 },
  openSync: vi.fn(() => 42),
  fstatSync: vi.fn(() => ({ isFile: () => true, size: source.reportedSize })),
  lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
  closeSync: vi.fn(),
  readFileSync: vi.fn(() => {
    if (source.failure !== null) throw source.failure
    return new TextDecoder().decode(source.bytes)
  }),
  readSync: vi.fn((_descriptor: number, buffer: Uint8Array, offset: number, length: number) => {
    if (source.failure !== null) throw source.failure
    const chunk = source.bytes.subarray(
      source.position,
      source.position + Math.min(length, source.chunkLimit),
    )
    buffer.set(chunk, offset)
    source.position += chunk.length
    return chunk.length
  }),
}))

beforeEach(() => {
  source.bytes = new Uint8Array()
  source.position = 0
  source.reportedSize = 0
  source.chunkLimit = Number.MAX_SAFE_INTEGER
  source.failure = null
  vi.mocked(closeSync).mockReset()
  vi.mocked(openSync).mockClear()
})

it("enforces the byte limit even when the file grows after metadata inspection", () => {
  source.bytes = new TextEncoder().encode("growing document beyond the limit")
  source.reportedSize = 1
  expect(() => readRegularText("/memory-file", 4)).toThrow("4 byte read limit")
  expect(source.position).toBeLessThanOrEqual(5)
  expect(closeSync).toHaveBeenCalledOnce()
})

it("accepts an exact byte limit and UTF-8 characters split across short reads", () => {
  source.bytes = new TextEncoder().encode("あ😀")
  source.chunkLimit = 1
  expect(readRegularText("/memory-file", source.bytes.length)).toBe("あ😀")
  expect(closeSync).toHaveBeenCalledOnce()
})

it("accepts an empty file at a zero-byte limit", () => {
  expect(readRegularText("/memory-file", 0)).toBe("")
})

it("preserves invalid and incomplete UTF-8 bytes across short reads for recovery backups", () => {
  source.bytes = new Uint8Array([0x7b, 0x22, 0x80, 0xff, 0xf0, 0x9f])
  source.chunkLimit = 1
  const recovered = readRegularBytes("/memory-file", source.bytes.length)
  expect(recovered).toEqual(Buffer.from(source.bytes))
  expect(closeSync).toHaveBeenCalledOnce()
})

it("preserves a UTF-8 BOM and decodes an incomplete final character consistently", () => {
  source.bytes = new TextEncoder().encode("\ufefftext")
  source.chunkLimit = 1
  expect(readRegularText("/memory-file", source.bytes.length)).toBe("\ufefftext")
  source.bytes = new Uint8Array([0xf0, 0x9f])
  source.position = 0
  expect(readRegularText("/memory-file", 2)).toBe("�")
})

it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER])(
  "rejects invalid byte limits before opening files: %s",
  (limit) => {
    expect(() => readRegularText("/memory-file", limit)).toThrow("Text read limit")
    expect(openSync).not.toHaveBeenCalled()
  },
)

it("retains read and descriptor-close failures together", () => {
  source.failure = new Error("read failed")
  vi.mocked(closeSync).mockImplementationOnce(() => {
    throw new Error("close failed")
  })
  const failure = (() => {
    try {
      readRegularText("/memory-file", 4)
    } catch (error) {
      return error
    }
  })()
  const messages = errorDetails(failure).map((cause) => cause.message)
  expect(messages).toEqual(expect.arrayContaining(["read failed", "close failed"]))
})
