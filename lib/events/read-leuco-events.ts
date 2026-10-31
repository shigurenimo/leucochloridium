import { storedLeucoEventTypes } from "@/events/stored-leuco-event-types"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { statSync } from "node:fs"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { parseStoredLeucoEvent } from "@/events/parse-stored-leuco-event"
import { applySqliteBusyTimeout } from "@/event-log/sqlite-busy-timeout"

const rowSchema = z.object({ seq: z.number(), ts: z.number(), event: z.string() })
type Filters = {
  requestId?: string
  type?: string
  since?: number
  summary?: boolean
  failuresOnly?: boolean
}
export function readLeucoEvents(path: string, limit: number, filters: Filters = {}) {
  if (!statSync(path).isFile()) throw new Error("Event log must be a regular database file")
  const conditions = ["1=1"]
  const bindings: Array<string | number> = []
  if (filters.failuresOnly)
    conditions.push(
      `((type = 'turn.error' AND COALESCE(json_extract(event, '$.cancelled'), 0) = 0)
        OR type IN ('turn.rejected', 'supervisor.reconcile.failed', 'engine.reconcile.failed')
        OR (type = 'codex.recovery' AND json_extract(event, '$.status') = 'failed')
        OR (type = 'maintenance' AND json_extract(event, '$.status') IN ('failed', 'uncertain'))
        OR (type IN ('slack.error', 'log') AND json_extract(event, '$.level') = 'error'))`,
    )
  if (filters.summary) {
    conditions.push("type != 'codex.notification'")
    conditions.push("(type != 'log' OR json_extract(event, '$.level') IN ('warn', 'error'))")
  }
  if (filters.requestId !== undefined) {
    conditions.push("json_extract(event, '$.requestId') = ?")
    bindings.push(filters.requestId)
  }
  if (filters.type !== undefined) {
    const storedTypes = storedLeucoEventTypes(filters.type)
    conditions.push(`type IN (${storedTypes.map(() => "?").join(", ")})`)
    bindings.push(...storedTypes)
  }
  if (filters.since !== undefined) {
    conditions.push("ts >= ?")
    bindings.push(filters.since)
  }
  const database = new Database(path, { readonly: true })
  return withSyncCleanup(
    () => {
      applySqliteBusyTimeout(database, 250)
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
            event: parseStoredLeucoEvent(parsed.event, parsed.seq),
          }
        })
    },
    () => database.close(),
  )
}
