import { redactPublicText } from "@/secrets/redact-public-text"
import { statSync } from "node:fs"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { leucoEventReadSchema } from "@/events/leuco-event-read-schema"

const rowSchema = z.object({ seq: z.number(), ts: z.number(), event: z.string() })
type Filters = { requestId?: string; type?: string; since?: number }
export function readLeucoEvents(path: string, limit: number, filters: Filters = {}) {
  if (!statSync(path).isFile()) throw new Error("Event log must be a regular database file")
  const database = new Database(path, { readonly: true })
  const conditions = ["1=1"]
  const bindings: Array<string | number> = []
  if (filters.requestId !== undefined) {
    conditions.push("json_extract(event, '$.requestId') = ?")
    bindings.push(filters.requestId)
  }
  if (filters.type !== undefined) {
    conditions.push("type = ?")
    bindings.push(filters.type)
  }
  if (filters.since !== undefined) {
    conditions.push("ts >= ?")
    bindings.push(filters.since)
  }
  try {
    return database
      .query(
        `SELECT seq, ts, event FROM logs WHERE ${conditions.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...bindings, limit)
      .map((row) => {
        const parsed = rowSchema.parse(row)
        return {
          seq: parsed.seq,
          ts: parsed.ts,
          event: leucoEventReadSchema.parse(JSON.parse(redactPublicText(parsed.event))),
        }
      })
  } finally {
    database.close()
  }
}
