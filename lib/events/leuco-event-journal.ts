import type { EventJournalRecord } from "@/event-journal/event-journal-record"
import { EventJournal } from "@/event-journal/event-journal"
import { MemoryEventJournal } from "@/event-journal/memory-event-journal"
import { SqliteEventJournal } from "@/event-journal/sqlite-event-journal"
import { compactLeucoEvent } from "@/events/compact-leuco-event"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { maintainLeucoEventJournal } from "@/events/maintain-leuco-event-journal"
import { queryLeucoEventRecords } from "@/events/query-leuco-event-records"

export const DEFAULT_EVENT_LOG_MAX_ROWS = 50_000
export const DEFAULT_EVENT_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_EVENT_LOG_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_EVENT_LOG_TARGET_BYTES = 48 * 1024 * 1024

export type LeucoEventJournalProps = {
  eventLogPath?: string
  now?: () => number
  maxRows?: number
  maxAgeMs?: number
  maxBytes?: number
  targetBytes?: number
}

export class LeucoEventJournal {
  private readonly store:
    | MemoryEventJournal<LeucoEvent>
    | SqliteEventJournal<LeucoEvent, ["project"]>
  private readonly journal: EventJournal<LeucoEvent>
  private readonly now: () => number
  private isClosed = false

  constructor(props: LeucoEventJournalProps = {}) {
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
      : new MemoryEventJournal<LeucoEvent>({ capacity: maxRows })
    this.journal = new EventJournal<LeucoEvent>({
      validate: leucoEventSchema.safeParse,
      primary: this.store,
      now: this.now,
    })
  }

  append(event: LeucoEvent): void {
    if (this.isClosed) return

    const outcome = this.journal.append(compactLeucoEvent(event))
    if (!(outcome instanceof Error)) return

    process.stderr.write(`[leuco] event persist failed: ${outcome.message}\n`)
  }

  log(level: "info" | "warn" | "error", line: string): void {
    this.append({ ts: this.now(), type: "log", level, line })
  }

  query(query: LeucoEventQuery = {}): ReadonlyArray<EventJournalRecord<LeucoEvent>> {
    if (this.store instanceof MemoryEventJournal) {
      return queryLeucoEventRecords(this.store.query(), query)
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
    this.journal.close()
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

function buildSqliteStore(props: SqliteStoreProps): SqliteEventJournal<LeucoEvent, ["project"]> {
  maintainLeucoEventJournal(props)

  return new SqliteEventJournal<LeucoEvent, ["project"]>({
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
