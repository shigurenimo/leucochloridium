import type { EventLogEntry } from "@/event-log/event-log-entry"
import { EventLog } from "@/event-log/event-log"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { SqliteEventLog } from "@/event-log/sqlite-event-log"
import { compactLeucoEvent } from "@/events/compact-leuco-event"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { maintainLeucoEventLog } from "@/events/maintain-leuco-event-log"
import { queryLeucoEventEntries } from "@/events/query-leuco-event-entries"

export const DEFAULT_EVENT_LOG_MAX_ROWS = 50_000
export const DEFAULT_EVENT_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_EVENT_LOG_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_EVENT_LOG_TARGET_BYTES = 48 * 1024 * 1024

export type LeucoEventLogProps = {
  eventLogPath?: string
  now?: () => number
  maxRows?: number
  maxAgeMs?: number
  maxBytes?: number
  targetBytes?: number
}

export class LeucoEventLog {
  private readonly store: MemoryEventLog<LeucoEvent> | SqliteEventLog<LeucoEvent, ["project"]>
  private readonly eventLog: EventLog<LeucoEvent>
  private readonly now: () => number
  private isClosed = false

  constructor(props: LeucoEventLogProps = {}) {
    const maxRows = props.maxRows ?? DEFAULT_EVENT_LOG_MAX_ROWS
    const maxAgeMs = props.maxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS
    const maxBytes = props.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES
    const targetBytes = props.targetBytes ?? DEFAULT_EVENT_LOG_TARGET_BYTES

    this.now = props.now ?? Date.now
    this.store = props.eventLogPath
      ? buildSqliteStore({
          path: props.eventLogPath,
          now: this.now,
          maxRows,
          maxAgeMs,
          maxBytes,
          targetBytes,
        })
      : new MemoryEventLog<LeucoEvent>({ capacity: maxRows })
    this.eventLog = new EventLog<LeucoEvent>({
      validate: leucoEventSchema.safeParse,
      primary: this.store,
      now: this.now,
    })
  }

  append(event: LeucoEvent): void {
    if (this.isClosed) return

    const outcome = this.eventLog.append(compactLeucoEvent(event))
    if (!(outcome instanceof Error)) return

    process.stderr.write(`[leuco] event persist failed: ${outcome.message}\n`)
  }

  log(level: "info" | "warn" | "error", line: string): void {
    this.append({ ts: this.now(), type: "log", level, line })
  }

  query(query: LeucoEventQuery = {}): ReadonlyArray<EventLogEntry<LeucoEvent>> {
    if (this.store instanceof MemoryEventLog) {
      return queryLeucoEventEntries(this.store.query(), query)
    }

    return this.store.query({
      ...(query.sinceSeq !== undefined ? { sinceSeq: query.sinceSeq } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.project !== undefined ? { where: { project: query.project } } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.order !== undefined ? { order: query.order } : {}),
    })
  }

  close(): void {
    if (this.isClosed) return

    this.isClosed = true
    this.eventLog.close()
  }
}

type SqliteStoreProps = {
  path: string
  now: () => number
  maxRows: number
  maxAgeMs: number
  maxBytes: number
  targetBytes: number
}

function buildSqliteStore(props: SqliteStoreProps): SqliteEventLog<LeucoEvent, ["project"]> {
  maintainLeucoEventLog(props)

  return new SqliteEventLog<LeucoEvent, ["project"]>({
    path: props.path,
    indexes: ["project"],
    extractIndexes: projectIndexOf,
    now: props.now,
    maxRows: props.maxRows,
    maxAgeMs: props.maxAgeMs,
    maxBytes: props.maxBytes,
    targetBytes: props.targetBytes,
  })
}

function projectIndexOf(event: LeucoEvent): { project: string | null } {
  if (!("project" in event)) return { project: null }

  return { project: typeof event.project === "string" ? event.project : null }
}
