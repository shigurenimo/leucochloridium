import { expect, it, vi } from "vitest"
import { readRegularJson } from "@/fs/read-regular-json"
import { readRegularBytes } from "@/fs/read-regular-bytes"

vi.mock("@/fs/read-regular-bytes", () => ({ readRegularBytes: vi.fn() }))

it.each([
  [34, 255, 34],
  [34, 227, 34],
  [34, 192, 175, 34],
])("rejects malformed UTF-8 JSON: %j", (...bytes) => {
  vi.mocked(readRegularBytes).mockReturnValue(Buffer.from(bytes))
  expect(() => readRegularJson("/memory/settings.json")).toThrow("not valid UTF-8 JSON")
})

it("reads valid UTF-8 JSON without changing content", () => {
  vi.mocked(readRegularBytes).mockReturnValue(Buffer.from('{"text":"あ😀"}'))
  expect(readRegularJson("/memory/settings.json")).toEqual({ text: "あ😀" })
})
