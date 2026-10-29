import { existsSync, statSync } from "node:fs"
import { errorDetails } from "@/error-details"
import type { EventLogEntry } from "@/event-log/event-log-entry"
import { redactPublicText } from "@/secrets/redact-public-text"
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
  onFallback?: (event: LeucoEvent) => void
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
  private instanceId: string | null = null
  private lastPersistError: { ts: number; message: string } | null = null
  private mode: "sqlite" | "memory" | "memory-fallback" = "memory"
  private memoryWrites = 0
  private lastFallbackError: string | null = null
  private readonly onFallback: ((event: LeucoEvent) => void) | undefined
  private lastWriteFailed = false
  private lastErrorReportedAt = 0
  private lastSuccessfulWriteAt: number | null = null
  private readonly retention: {
    maxRows: number
    maxAgeMs: number
    maxBytes: number
    targetBytes: number
  }
  private successfulWrites = 0
  private failedWrites = 0
  private isClosed = false
  private redactionSecrets: string[] = []

  constructor(props: LeucoEventLogProps = {}) {
    const maxRows = props.maxRows ?? DEFAULT_EVENT_LOG_MAX_ROWS
    const maxAgeMs = props.maxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS
    const maxBytes = props.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES
    const targetBytes = props.targetBytes ?? DEFAULT_EVENT_LOG_TARGET_BYTES

    this.onFallback = props.onFallback
    this.retention = { maxRows, maxAgeMs, maxBytes, targetBytes }
    this.now = props.now ?? Date.now
    if (props.eventLogPath) {
      try {
        if (existsSync(props.eventLogPath) && !statSync(props.eventLogPath).isFile())
          throw new Error("Event database must be a regular file, never a pipe/device")
        this.store = buildSqliteStore({
          path: props.eventLogPath,
          now: this.now,
          maxRows,
          maxAgeMs,
          maxBytes,
          targetBytes,
        })
        this.mode = "sqlite"
      } catch (error) {
        this.store = new MemoryEventLog<LeucoEvent>({ capacity: Math.min(maxRows, 1000) })
        this.mode = "memory-fallback"
        this.lastWriteFailed = true
        this.failedWrites += 1
        this.lastPersistError = {
          ts: this.now(),
          message: this.redactText(error instanceof Error ? error.message : String(error)).slice(
            0,
            4000,
          ),
        }
        process.stderr.write(
          `[leuco] event database unavailable; retaining up to 1000 volatile events: ${this.lastPersistError.message}\n`,
        )
      }
    } else this.store = new MemoryEventLog<LeucoEvent>({ capacity: maxRows })
    this.eventLog = new EventLog<LeucoEvent>({
      validate: leucoEventSchema.safeParse,
      primary: this.store,
      now: this.now,
    })
  }

  getHealth() {
    return {
      mode: this.mode,
      durable: this.mode === "sqlite",
      memoryWrites: this.memoryWrites,
      lastFallbackError: this.lastFallbackError,
      fallbackCapacity:
        this.mode === "memory-fallback" ? Math.min(this.retention.maxRows, 1000) : null,
      lastWriteFailed: this.lastWriteFailed,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      successfulWrites: this.successfulWrites,
      failedWrites: this.failedWrites,
      lastPersistError: this.lastPersistError === null ? null : { ...this.lastPersistError },
      closed: this.isClosed,
      retention: { ...this.retention },
    }
  }

  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId
  }

  setRedactionSecrets(secrets: string[]): void {
    this.redactionSecrets = secrets.filter(Boolean)
  }

  redactText(text: string): string {
    return redactPublicText(
      this.redactionSecrets.reduce(
        (redacted, secret) => redacted.split(secret).join("[redacted]"),
        text,
      ),
    )
  }

  append(original: LeucoEvent): void {
    const event = this.instanceId === null ? original : { ...original, instanceId: this.instanceId }
    if (this.isClosed) return

    const outcome = (() => {
      try {
        const safe = leucoEventSchema.parse(JSON.parse(this.redactText(JSON.stringify(event))))
        const compact = compactLeucoEvent(safe)
        const inserted = this.eventLog.append(compact)
        if (this.mode === "memory-fallback" || inserted instanceof Error) {
          try {
            this.onFallback?.(compact)
          } catch (error) {
            this.lastFallbackError = this.redactText(
              error instanceof Error ? error.message : String(error),
            ).slice(0, 4000)
          }
        }
        return inserted
      } catch (error) {
        return new Error(
          `Event serialization/persistence failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    })()
    if (!(outcome instanceof Error)) {
      if (this.mode === "memory-fallback") {
        this.memoryWrites += 1
        return
      }
      this.successfulWrites += 1
      this.lastWriteFailed = false
      this.lastSuccessfulWriteAt = this.now()
      return
    }
    this.lastWriteFailed = true
    this.failedWrites += 1
    const shouldReport =
      this.lastErrorReportedAt === 0 || this.now() - this.lastErrorReportedAt > 60000
    this.lastPersistError = {
      ts: this.now(),
      message: this.redactText(outcome.message).slice(0, 4000),
    }
    if (shouldReport) {
      this.lastErrorReportedAt = this.now()
      process.stderr.write(`[leuco] event persist failed: ${this.lastPersistError.message}\n`)
    }
  }

  error(line: string, error: unknown, requestId?: string): void {
    this.append({
      ts: this.now(),
      type: "log",
      level: "error",
      line,
      requestId,
      causes: errorDetails(error),
    })
  }

  log(level: "info" | "warn" | "error", line: string, requestId?: string): void {
    this.append({ ts: this.now(), type: "log", level, line, requestId })
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
