import { describe, expect, it } from "vitest"
import { toBoundedUploadBytes } from "@/actions/slack/to-bounded-upload-bytes"

describe("toBoundedUploadBytes", () => {
  it("joins chunks up to the configured byte limit", async () => {
    const chunks = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array([1, 2])
        yield new Uint8Array([3])
      },
    }

    const bounded = await toBoundedUploadBytes({ chunks, maxBytes: 3 })

    expect(Array.from(bounded.content)).toEqual([1, 2, 3])
    expect(bounded.exceedsLimit).toBe(false)
  })

  it("stops without retaining content once the byte limit is exceeded", async () => {
    const chunks = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array([1, 2])
        yield new Uint8Array([3, 4])
        throw new Error("must stop before another read")
      },
    }

    await expect(toBoundedUploadBytes({ chunks, maxBytes: 3 })).resolves.toEqual({
      content: new Uint8Array(),
      exceedsLimit: true,
    })
  })
})
