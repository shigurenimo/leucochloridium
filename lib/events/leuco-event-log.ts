import { existsSync, statSync } from "node:fs"
import { z } from "zod"
import { errorMessage } from "@/error-message"
import { toPublicDiagnosticMessage } from "@/to-public-diagnostic-message"
import { errorDetails } from "@/error-details"
import type { EventLogEntry } from "@/event-log/event-log-entry"
import { redactPublicText } from "@/secrets/redact-public-text"
import { EventLog } from "@/event-log/event-log"
import { MemoryEventLog } from "@/event-log/memory-event-log"
import { SqliteEventLog } from "@/event-log/sqlite-event-log"
import { compactLeucoEvent } from "@/events/compact-leuco-event"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { maintainLeucoEventLog } from "@/events/maintain-leuco-event-log"
import { queryLeucoEventEntries } from "@/events/query-leuco-event-entries"
import { redactJsonSecrets } from "@/secrets/redact-json-secrets"
import { copyRedactedError } from "@/secrets/copy-redacted-error"
import { NodeDiagnosticOutput } from "@/node-diagnostic-output"
import type { DiagnosticOutput } from "@/diagnostic-output"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { formatLogLine } from "@/format-log-line"
import { MEMORY_FALLBACK_CAPACITY } from "@/events/fallback-limits"

const DEFAULT_EVENT_LOG_MAX_ROWS = 50_000
const DEFAULT_EVENT_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_EVENT_LOG_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_EVENT_LOG_TARGET_BYTES = 48 * 1024 * 1024

type LeucoEventLogProps = {
  diagnosticOutput?: DiagnosticOutput | null
  eventLogPath?: string
  onFallback?: (event: LeucoEvent) => void
  now?: () => number
  maxRows?: number
  maxAgeMs?: number
  maxBytes?: number
  targetBytes?: number
}

export class LeucoEventLog {
  private readonly diagnosticOutput: DiagnosticOutput | null
  private readonly store: MemoryEventLog<LeucoEvent> | SqliteEventLog<LeucoEvent>
  private readonly eventLog: EventLog<LeucoEvent>
  private readonly now: () => number
  private instanceId: string | null = null
  private lastPersistError: {
    ts: number
    message: string
    causes: ReturnType<typeof errorDetails>
  } | null = null
  private lastCloseError: {
    ts: number
    message: string
    causes: ReturnType<typeof errorDetails>
  } | null = null
  private lastReportError: {
    ts: number
    message: string
    causes: ReturnType<typeof errorDetails>
  } | null = null
  private mode: "sqlite" | "memory" | "memory-fallback" = "memory"
  private memoryWrites = 0
  private lastFallbackError: string | null = null
  private readonly onFallback: ((event: LeucoEvent) => void) | undefined
  private lastWriteFailed = false
  private lastErrorReportedTick: number | null = null
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
    const targetBytes =
      props.targetBytes ?? Math.min(DEFAULT_EVENT_LOG_TARGET_BYTES, Math.floor(maxBytes * 0.75))
    const retention = { maxRows, maxAgeMs, maxBytes, targetBytes }
    for (const entry of Object.entries(retention))
      if (!Number.isSafeInteger(entry[1]) || entry[1] < 0)
        throw new RangeError(`Event log ${entry[0]} must be a non-negative safe integer`)
    if (maxBytes === 0) throw new RangeError("Event log maxBytes must be positive")
    if (targetBytes > maxBytes)
      throw new RangeError("Event log targetBytes must not exceed maxBytes")

    this.diagnosticOutput =
      props.diagnosticOutput === undefined ? new NodeDiagnosticOutput() : props.diagnosticOutput
    this.onFallback = props.onFallback
    this.retention = retention
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
        this.store = new MemoryEventLog<LeucoEvent>({
          capacity: Math.min(maxRows, MEMORY_FALLBACK_CAPACITY),
        })
        this.mode = "memory-fallback"
        this.recordPersistenceFailure(
          error,
          `event database unavailable; retaining up to ${MEMORY_FALLBACK_CAPACITY} volatile events`,
        )
      }
    } else this.store = new MemoryEventLog<LeucoEvent>({ capacity: maxRows })
    this.eventLog = new EventLog<LeucoEvent>({
      // append() parses and compacts each event before dispatch, so the shared validator only forwards it.
      validate: z.custom<LeucoEvent>().safeParse,
      // This wrapper owns the store lifetime; the shared dispatcher intentionally swallows close errors.
      primary: {
        insert: (input) => this.store.insert(input),
        getMaxSeq: () => this.store.getMaxSeq(),
      },
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
        this.mode === "memory-fallback"
          ? Math.min(this.retention.maxRows, MEMORY_FALLBACK_CAPACITY)
          : null,
      lastWriteFailed: this.lastWriteFailed,
      lastSuccessfulWriteAt: this.lastSuccessfulWriteAt,
      successfulWrites: this.successfulWrites,
      failedWrites: this.failedWrites,
      lastPersistError:
        this.lastPersistError === null
          ? null
          : {
              ...this.lastPersistError,
              causes: this.lastPersistError.causes.map((cause) => ({ ...cause })),
            },
      closed: this.isClosed,
      lastCloseError:
        this.lastCloseError === null
          ? null
          : {
              ...this.lastCloseError,
              causes: this.lastCloseError.causes.map((cause) => ({ ...cause })),
            },
      lastReportError:
        this.lastReportError === null
          ? null
          : {
              ...this.lastReportError,
              causes: this.lastReportError.causes.map((cause) => ({ ...cause })),
            },
      retention: { ...this.retention },
    }
  }

  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId
  }

  setRedactionSecrets(secrets: string[]): void {
    this.redactionSecrets = secrets.filter(Boolean)
  }

  addRedactionSecrets(secrets: ReadonlyArray<string>): void {
    this.redactionSecrets = [...new Set([...this.redactionSecrets, ...secrets].filter(Boolean))]
  }

  redactValue(value: unknown): unknown {
    return redactJsonSecrets(value, this.redactionSecrets)
  }

  redactError(error: unknown): Error {
    return copyRedactedError(error, this.redactionSecrets)
  }

  redactText(text: string): string {
    return redactPublicText(text, this.redactionSecrets)
  }

  append(original: LeucoEvent): void {
    const event = this.instanceId === null ? original : { ...original, instanceId: this.instanceId }
    if (this.isClosed) return

    const outcome = (() => {
      try {
        const safe = leucoEventSchema.parse(this.redactValue(event))
        const compact = compactLeucoEvent(safe)
        const inserted = this.eventLog.append(compact)
        if (this.mode !== "sqlite" && !(inserted instanceof Error)) this.memoryWrites += 1
        if (this.mode === "memory-fallback" || inserted instanceof Error) {
          const failure = this.mirrorEvent(compact, inserted instanceof Error ? inserted : null)
          if (failure !== null) return failure
        }
        return inserted
      } catch (error) {
        return new Error(`Event serialization/persistence failed: ${errorMessage(error)}`, {
          cause: error,
        })
      }
    })()
    if (!(outcome instanceof Error)) {
      if (this.mode === "memory-fallback") return
      this.successfulWrites += 1
      this.lastWriteFailed = false
      this.lastSuccessfulWriteAt = this.now()
      return
    }
    this.recordPersistenceFailure(outcome)
  }

  private mirrorEvent(event: LeucoEvent, primaryFailure: Error | null): Error | null {
    try {
      this.onFallback?.(event)
      return primaryFailure
    } catch (error) {
      this.lastFallbackError = toPublicDiagnosticMessage(errorMessage(error), this.redactionSecrets)
      if (primaryFailure === null)
        return new Error(`Event fallback mirror failed: ${errorMessage(error)}`, { cause: error })
      return new AggregateError(
        [primaryFailure, error],
        `${errorMessage(primaryFailure)}; event fallback also failed: ${errorMessage(error)}`,
        { cause: primaryFailure },
      )
    }
  }

  private recordPersistenceFailure(error: unknown, prefix = "event persist failed"): void {
    this.lastWriteFailed = true
    this.failedWrites += 1
    this.lastPersistError = {
      ts: this.now(),
      message: toPublicDiagnosticMessage(errorMessage(error), this.redactionSecrets),
      causes: errorDetails(error, this.redactionSecrets),
    }
    if (this.diagnosticOutput === null) return
    if (
      this.lastErrorReportedTick !== null &&
      performance.now() - this.lastErrorReportedTick <= 60000
    )
      return
    this.lastErrorReportedTick = performance.now()
    const failure = this.lastPersistError
    const secrets = [...this.redactionSecrets]
    const primary = copyRedactedError(error, secrets)
    const reportFailure = (reporting: unknown): void => {
      const causes = errorDetails(
        new AggregateError(
          [primary, reporting],
          "Event persistence and diagnostic reporting failed",
          { cause: primary },
        ),
        secrets,
      )
      this.lastReportError = {
        ts: this.now(),
        message: "Event persistence and diagnostic reporting failed",
        causes,
      }
      if (this.lastPersistError === failure) failure.causes = causes
    }
    try {
      void awaitBoundedCleanup(
        this.diagnosticOutput.write(`${formatLogLine(`[leuco] ${prefix}: ${failure.message}`)}\n`),
        "Event error diagnostic output",
      ).catch(reportFailure)
    } catch (reporting) {
      reportFailure(reporting)
    }
  }

  error(line: string, error: unknown, requestId?: string): void {
    this.append({
      ts: this.now(),
      type: "log",
      level: "error",
      line,
      requestId,
      causes: errorDetails(error, this.redactionSecrets),
    })
  }

  log(level: "info" | "warn" | "error", line: string, requestId?: string): void {
    this.append({ ts: this.now(), type: "log", level, line, requestId })
  }

  query(query: LeucoEventQuery = {}): ReadonlyArray<EventLogEntry<LeucoEvent>> {
    const limit = query.limit ?? 1000
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError("Event query limit must be a non-negative safe integer")
    if (!(this.store instanceof MemoryEventLog))
      throw new Error(
        "Event query only reads memory storage; read SQLite history with readLeucoEvents",
      )

    return queryLeucoEventEntries(this.store.query(), query).map((entry) => ({
      seq: entry.seq,
      ts: entry.ts,
      event: leucoEventSchema.parse(this.redactValue(entry.event)),
    }))
  }

  close(): void {
    if (this.isClosed) return
    try {
      if (this.store instanceof SqliteEventLog) this.store.close()
      this.eventLog.close()
      this.isClosed = true
      this.redactionSecrets = []
    } catch (error) {
      const safe = copyRedactedError(error, this.redactionSecrets)
      this.lastCloseError = { ts: this.now(), message: safe.message, causes: errorDetails(safe) }
      throw safe
    }
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

function buildSqliteStore(props: SqliteStoreProps): SqliteEventLog<LeucoEvent> {
  maintainLeucoEventLog(props)

  return new SqliteEventLog<LeucoEvent>({
    path: props.path,
    busyTimeoutMs: 250,
    now: props.now,
    maxRows: props.maxRows,
    maxAgeMs: props.maxAgeMs,
    maxBytes: props.maxBytes,
    targetBytes: props.targetBytes,
  })
}
