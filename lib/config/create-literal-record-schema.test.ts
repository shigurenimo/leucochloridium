import { expect, it } from "vitest"
import { z } from "zod"
import { createLiteralRecordSchema } from "@/config/create-literal-record-schema"

const schema = createLiteralRecordSchema(z.object({ id: z.string() }))
it.each([null, [], new Date(0), 1, "text"])("rejects non-record input %j", (value) => {
  expect(schema.safeParse(value).success).toBe(false)
})
it("validates special keys instead of silently dropping malformed values", () => {
  const parsed = schema.safeParse(JSON.parse('{"__proto__":{"id":123}}'))
  expect(parsed.success).toBe(false)
  if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["__proto__", "id"])
})
it("reads only own entries and accepts a record with no prototype", () => {
  const record: Record<string, unknown> = Object.create(null)
  Object.defineProperty(record, "constructor", { value: { id: "saved" }, enumerable: true })
  expect(schema.parse(record)).toEqual({ constructor: { id: "saved" } })
})
