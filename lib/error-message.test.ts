import { describe, expect, it } from "vitest"
import { errorMessage } from "@/error-message"

describe("errorMessage", () => {
  it("returns Error.message for Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
  })

  it("stringifies non-Error values", () => {
    expect(errorMessage("plain string")).toBe("plain string")
    expect(errorMessage(42)).toBe("42")
    expect(errorMessage({ code: 1 })).toBe("[object Object]")
    expect(errorMessage(null)).toBe("null")
    expect(errorMessage(undefined)).toBe("undefined")
  })

  it("handles Error subclasses", () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError("custom"))).toBe("custom")
  })
})
