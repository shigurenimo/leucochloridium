import { describe, expect, it } from "vitest"
import { parseArguments } from "@/cli/parse-arguments"

describe("flat CLI arguments", () => {
  it("accepts both flag syntaxes and the explicit end of flags", () => {
    expect(parseArguments(["run", "--cwd=/work", "--soul", "/soul", "--", "--text"])).toEqual({
      words: ["run", "--text"],
      flags: { cwd: "/work", soul: "/soul" },
    })
  })
  it("allows the soul to be turned off without a value", () => {
    expect(parseArguments(["run", "--no-soul"]).flags["no-soul"]).toBe(true)
  })
  it.each([
    ["run", "--soul"],
    ["run", "--soul", "--cwd", "/work"],
    ["run", "--soul=a", "--no-soul"],
    ["run", "--no-soul=false"],
    ["run", "--project", "demo"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parseArguments(args)).toThrow()
  })
})
