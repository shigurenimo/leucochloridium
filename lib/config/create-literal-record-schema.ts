import { z } from "zod"

/** Validate own entries without dropping the literal __proto__ key. */
export function createLiteralRecordSchema<Schema extends z.ZodType>(valueSchema: Schema) {
  return z
    .custom<Record<string, unknown>>((value) => {
      if (value === null || typeof value !== "object") return false
      const prototype = Object.getPrototypeOf(value)
      return prototype === null || prototype === Object.prototype
    }, "Expected a plain object")
    .transform((record, context): Record<string, z.output<Schema>> => {
      const entries: Array<[string, z.output<Schema>]> = []
      for (const key of Object.keys(record)) {
        const parsed = valueSchema.safeParse(record[key])
        if (!parsed.success) {
          for (const issue of parsed.error.issues)
            context.addIssue({ ...issue, path: [key, ...issue.path] })
          continue
        }
        entries.push([key, parsed.data])
      }
      return Object.fromEntries(entries)
    })
}
