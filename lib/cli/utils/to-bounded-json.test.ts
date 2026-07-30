import { describe, expect, it } from "vitest"
import { MAX_CLI_JSON_CHARS, toBoundedJson } from "@/cli/utils/to-bounded-json"

describe("toBoundedJson", () => {
  it("keeps a small result unchanged", () => {
    expect(toBoundedJson({ ok: true, messages: [] })).toBe(
      JSON.stringify({ ok: true, messages: [] }, null, 2),
    )
  })

  it("returns valid bounded JSON with a preview for a huge tool result", () => {
    const text = toBoundedJson({
      ok: true,
      messages: [{ text: `${'\\"\n'.repeat(80_000)}${"応答".repeat(80_000)}` }],
    })
    const parsed: unknown = JSON.parse(text)

    expect(text.length).toBeLessThanOrEqual(MAX_CLI_JSON_CHARS)
    expect(parsed).toEqual(
      expect.objectContaining({
        _leuco: expect.objectContaining({
          truncated: true,
          originalChars: expect.any(Number),
          previewChars: expect.any(Number),
        }),
        preview: expect.any(String),
      }),
    )
  })

  it("rejects an unusably small bound", () => {
    expect(() => toBoundedJson({ ok: true }, 100)).toThrow("maxChars")
  })

  it("preserves pagination hints that occur after a truncated payload", () => {
    const text = toBoundedJson(
      {
        ok: true,
        messages: [{ text: "x".repeat(20_000) }],
        response_metadata: { next_cursor: "cursor-next" },
      },
      2_000,
    )
    const parsed: unknown = JSON.parse(text)

    expect(parsed).toEqual(
      expect.objectContaining({
        _leuco: expect.objectContaining({
          continuation: { nextCursor: "cursor-next" },
        }),
      }),
    )
  })
})
