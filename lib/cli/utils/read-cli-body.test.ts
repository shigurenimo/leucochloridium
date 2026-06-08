import { HTTPException } from "hono/http-exception"
import { describe, expect, it } from "vitest"
import { flagBool, flagString, readCliBody } from "@/cli/utils/read-cli-body"

const fakeContext = (text: string) =>
  ({
    req: {
      text: async (): Promise<string> => text,
    },
  }) as Parameters<typeof readCliBody>[0]

describe("readCliBody", () => {
  it("parses well-formed body", async () => {
    const body = await readCliBody(fakeContext(JSON.stringify({ args: ["a"], flags: { x: "y" } })))
    expect(body.args).toEqual(["a"])
    expect(body.flags).toEqual({ x: "y" })
  })

  it("falls back to defaults on missing fields", async () => {
    const body = await readCliBody(fakeContext("{}"))
    expect(body.args).toEqual([])
    expect(body.flags).toEqual({})
  })

  it("treats an empty body as defaults (covers no-body CLI invocations)", async () => {
    const body = await readCliBody(fakeContext(""))
    expect(body.args).toEqual([])
    expect(body.flags).toEqual({})
  })

  it("throws HTTPException 400 on malformed JSON instead of silently dropping args", async () => {
    await expect(readCliBody(fakeContext("not-json"))).rejects.toBeInstanceOf(HTTPException)
  })
})

describe("flagBool", () => {
  it("returns true for boolean true", () => {
    expect(flagBool(true)).toBe(true)
  })

  it("returns true for string 'true'", () => {
    expect(flagBool("true")).toBe(true)
  })

  it("returns false for false / undefined / other strings", () => {
    expect(flagBool(false)).toBe(false)
    expect(flagBool(undefined)).toBe(false)
    expect(flagBool("false")).toBe(false)
    expect(flagBool("yes")).toBe(false)
  })
})

describe("flagString", () => {
  it("returns the string value", () => {
    expect(flagString("hello")).toBe("hello")
  })

  it("returns null for boolean values", () => {
    expect(flagString(true)).toBe(null)
    expect(flagString(false)).toBe(null)
  })

  it("returns null for undefined", () => {
    expect(flagString(undefined)).toBe(null)
  })
})
