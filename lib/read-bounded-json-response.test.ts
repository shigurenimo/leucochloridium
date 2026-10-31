import { expect, it } from "vitest"
import { readBoundedJsonResponse } from "@/read-bounded-json-response"

it.each([
  [34, 255, 34],
  [34, 227, 34],
  [34, 192, 175, 34],
])("rejects malformed UTF-8 rather than changing JSON content: %j", async (...bytes) => {
  const response = new Response(new Uint8Array(bytes))
  const failure = await readBoundedJsonResponse({
    response,
    label: "JSON probe",
    signal: new AbortController().signal,
    maxBytes: 1024,
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(response.body?.locked).toBe(false)
})

it("preserves a valid UTF-8 character split across byte chunks", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(output) {
      for (const byte of [34, 240, 159, 152, 128, 34]) output.enqueue(new Uint8Array([byte]))
      output.close()
    },
  })
  await expect(
    readBoundedJsonResponse({
      response: new Response(body),
      label: "JSON probe",
      signal: new AbortController().signal,
      maxBytes: 1024,
    }),
  ).resolves.toBe("😀")
})
