import type { EventLogEntry } from "@/event-log/event-log-entry"
import { EventLog } from "@/event-log/event-log"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { SqliteEventLog } from "@/event-log/sqlite-event-log"
import { compactLeucoEvent } from "@/events/compact-leuco-event"
import { leucoEventReadSchema } from "@/events/leuco-event-read-schema"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { maintainLeucoEventLog } from "@/events/maintain-leuco-event-log"
import { queryLeucoEventEntries } from "@/events/query-leuco-event-entries"
import { storedLeucoEventTypes } from "@/events/stored-leuco-event-types"

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
  private readonly store: MemoryEventLog<LeucoEvent> | SqliteEventLog<LeucoEvent, ["runtime"]>
  private readonly eventLog: EventLog<LeucoEvent>
  private readonly now: () => number
  private isClosed = false
  private redactionSecrets: string[] = []

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

  setRedactionSecrets(secrets: string[]): void {
    this.redactionSecrets = secrets.filter(Boolean)
  }

  redactText(text: string): string {
    return this.redactionSecrets.reduce(
      (redacted, secret) => redacted.split(secret).join("[redacted]"),
      text,
    )
  }

  append(event: LeucoEvent): void {
    if (this.isClosed) return

    const safe: LeucoEvent =
      this.redactionSecrets.length === 0
        ? event
        : leucoEventSchema.parse(JSON.parse(this.redactText(JSON.stringify(event))))
    const outcome = this.eventLog.append(compactLeucoEvent(safe))
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

    const storedTypes = query.type === undefined ? [null] : storedLeucoEventTypes(query.type)
    const entries = storedTypes.flatMap((type) =>
      this.store.query({
        ...(query.sinceSeq !== undefined ? { sinceSeq: query.sinceSeq } : {}),
        ...(type === null ? {} : { type }),
        ...(query.runtime !== undefined ? { where: { runtime: query.runtime } } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.order !== undefined ? { order: query.order } : {}),
      }),
    )
    const normalized = entries
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => ({
        seq: entry.seq,
        ts: entry.ts,
        event: leucoEventReadSchema.parse(entry.event),
      }))

    return queryLeucoEventEntries(normalized, query)
  }

  close(): void {
    if (this.isClosed) return

    this.isClosed = true
    this.redactionSecrets = []
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

function buildSqliteStore(props: SqliteStoreProps): SqliteEventLog<LeucoEvent, ["runtime"]> {
  maintainLeucoEventLog(props)

  return new SqliteEventLog<LeucoEvent, ["runtime"]>({
    path: props.path,
    indexes: ["runtime"],
    extractIndexes: runtimeIndexOf,
    now: props.now,
    maxRows: props.maxRows,
    maxAgeMs: props.maxAgeMs,
    maxBytes: props.maxBytes,
    targetBytes: props.targetBytes,
  })
}

function runtimeIndexOf(event: LeucoEvent): { runtime: string | null } {
  if (!("runtime" in event)) return { runtime: null }

  return { runtime: typeof event.runtime === "string" ? event.runtime : null }
}
