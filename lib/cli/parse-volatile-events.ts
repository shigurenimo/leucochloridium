import { z } from "zod"
import { leucoEventReadSchema } from "@/events/leuco-event-read-schema"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import { queryLeucoEventEntries } from "@/events/query-leuco-event-entries"

export function parseVolatileEvents(value: unknown, query: LeucoEventQuery) {
  const entries = z
    .array(
      z.object({
        seq: z.number().int().positive(),
        ts: z.number(),
        event: leucoEventReadSchema,
      }),
    )
    .max(query.limit ?? 1000)
    .parse(value)
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.seq <= entry.seq))
    throw new Error("Volatile history must contain distinct sequences in newest-first order")
  if (queryLeucoEventEntries(entries, query).length !== entries.length)
    throw new Error("Volatile history does not match the requested filters")
  return entries
}
