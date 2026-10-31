import { expect, it } from "vitest"
import { tailLogLines } from "@/daemon/tail-log-lines"

it("reads only the requested tail in chronological order", () => {
  expect(tailLogLines("first\nsecond\nthird\n", 2)).toEqual(["second", "third"])
  expect(tailLogLines("first\nsecond\nthird", 2)).toEqual(["second", "third"])
})

it("preserves blank records, trailing spaces and CRLF framing", () => {
  expect(tailLogLines("first\r\n\r\nlast  \r\n", 3)).toEqual(["first", "", "last  "])
  expect(tailLogLines("\n", 3)).toEqual([""])
  expect(tailLogLines("", 3)).toEqual([])
})

it("bounds a huge line while retaining the following diagnostic records", () => {
  const lines = tailLogLines(`${"x".repeat(1_000_000)}\nlast failure\n`, 2)
  expect(lines[0]?.length).toBeLessThan(16500)
  expect(lines[0]).toContain("truncated log line")
  expect(lines[1]).toBe("last failure")
})

it("does not split an entire file just to read one recent record", () => {
  expect(tailLogLines(`${"\n".repeat(100000)}最後の記録\n`, 1)).toEqual(["最後の記録"])
})

it("keeps emoji intact at the truncation boundary", () => {
  const line = tailLogLines(`a${"😀".repeat(9000)}`, 1)[0]!
  expect(line.isWellFormed()).toBe(true)
  expect(line).toContain("truncated log line")
})
