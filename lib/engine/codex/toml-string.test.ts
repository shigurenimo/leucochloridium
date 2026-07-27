import { describe, expect, it } from "vitest"
import { tomlString } from "@/engine/codex/toml-string"

describe("tomlString", () => {
  it("escapes quotes, slashes, whitespace controls, and forbidden controls", () => {
    expect(tomlString('a\\b"c\tline\nnext\r\u0000\u007f')).toBe(
      '"a\\\\b\\"c\\tline\\nnext\\r\\u0000\\u007f"',
    )
  })
})
