import { Database } from "bun:sqlite"
import { FunnelLog, FunnelLogSqliteSink } from "@interactive-inc/claude-funnel/logger"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEvent, LeucoEventListener } from "@/events/leuco-event-types"

export const DEFAULT_EVENT_LOG_MAX_ROWS = 50_000
export const DEFAULT_EVENT_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_EVENT_LOG_MAX_BYTES = 64 * 1024 * 1024
export const DEFAULT_EVENT_LOG_TARGET_BYTES = 48 * 1024 * 1024

export type LeucoEventBusProps = {
  eventLogPath?: string
  now?: () => number
  maxRows?: number
  maxAgeMs?: number
  maxBytes?: number
  targetBytes?: number
}

export class LeucoEventBus {
  private readonly eventLog: FunnelLog<LeucoEvent> | null
  private readonly sink: FunnelLogSqliteSink<LeucoEvent, ["project"]> | null
  private readonly listeners = new Set<LeucoEventListener>()
  private closed = false

  constructor(props: LeucoEventBusProps = {}) {
    if (props.eventLogPath) {
      const maxRows = props.maxRows ?? DEFAULT_EVENT_LOG_MAX_ROWS
      const maxAgeMs = props.maxAgeMs ?? DEFAULT_EVENT_LOG_MAX_AGE_MS
      const maxBytes = props.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES
      const targetBytes = props.targetBytes ?? DEFAULT_EVENT_LOG_TARGET_BYTES
      maintainEventLog({
        path: props.eventLogPath,
        maxRows,
        maxAgeMs,
        maxBytes,
        targetBytes,
        now: props.now ?? Date.now,
      })
      this.sink = new FunnelLogSqliteSink<LeucoEvent, ["project"]>({
        path: props.eventLogPath,
        indexes: ["project"],
        extractIndexes: (event) => ({
          project: "project" in event && typeof event.project === "string" ? event.project : null,
        }),
        now: props.now,
        maxRows,
        maxAgeMs,
        maxBytes,
        targetBytes,
      })

      this.eventLog = new FunnelLog<LeucoEvent>({
        validate: leucoEventSchema.safeParse,
        primary: this.sink,
        now: props.now,
      })
    } else {
      this.sink = null
      this.eventLog = null
    }
  }

  emit(event: LeucoEvent): void {
    if (this.closed) return

    if (this.eventLog) {
      const result = this.eventLog.emit(compactEventForPersistence(event))

      if (result instanceof Error) {
        process.stderr.write(`[leuco] event persist failed: ${result.message}\n`)
      }
    }

    // Snapshot to survive subscribe()/unsubscribe() inside a listener.
    const snapshot = Array.from(this.listeners)
    for (const listener of snapshot) {
      try {
        listener(event)
      } catch {
        // faulty subscriber must not derail other listeners
      }
    }
  }

  log(level: "info" | "warn" | "error", line: string): void {
    this.emit({ ts: Date.now(), type: "log", level, line })
  }

  subscribe(listener: LeucoEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSink(): FunnelLogSqliteSink<LeucoEvent, ["project"]> | null {
    return this.sink
  }

  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.eventLog) this.eventLog.close()
  }
}

const MAX_PERSISTED_TURN_TEXT_CHARS = 16_000
const MAX_PERSISTED_NOTIFICATION_CHARS = 8_000

const compactEventForPersistence = (event: LeucoEvent): LeucoEvent => {
  if (event.type === "turn.start" && event.input.length > MAX_PERSISTED_TURN_TEXT_CHARS) {
    return {
      ...event,
      input: event.input.slice(0, MAX_PERSISTED_TURN_TEXT_CHARS),
      inputChars: event.input.length,
      inputTruncated: true,
    }
  }

  if (event.type === "turn.complete" && event.reply.length > MAX_PERSISTED_TURN_TEXT_CHARS) {
    return {
      ...event,
      reply: event.reply.slice(0, MAX_PERSISTED_TURN_TEXT_CHARS),
      replyChars: event.reply.length,
      replyTruncated: true,
    }
  }

  if (event.type !== "codex.notification") return event
  const json = stringifyForSize(event.params)
  if (json.length <= MAX_PERSISTED_NOTIFICATION_CHARS) return event
  return {
    ...event,
    params: {
      truncated: true,
      originalChars: json.length,
      preview: json.slice(0, MAX_PERSISTED_NOTIFICATION_CHARS),
    },
  }
}

const stringifyForSize = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

type EventLogMaintenanceProps = {
  path: string
  maxRows: number
  maxAgeMs: number
  maxBytes: number
  targetBytes: number
  now: () => number
}

/**
 * Apply retention before opening the long-lived sink. Row/age deletes keep
 * future growth bounded; when the database has already crossed the byte cap,
 * VACUUM returns old pages to the filesystem instead of leaving a large
 * high-water mark forever.
 */
const maintainEventLog = (props: EventLogMaintenanceProps): void => {
  if (props.path === ":memory:") return
  let db: Database | null = null
  try {
    db = new Database(props.path)
    const logsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'")
      .get()
    if (logsTable === null) return

    db.prepare(
      "DELETE FROM logs WHERE seq <= (SELECT seq FROM logs ORDER BY seq DESC LIMIT 1 OFFSET ?)",
    ).run(props.maxRows)
    db.prepare("DELETE FROM logs WHERE ts < ?").run(props.now() - props.maxAgeMs)

    const pageCount = (db.prepare("PRAGMA page_count").get() as { page_count?: number } | null)
      ?.page_count
    const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size?: number } | null)
      ?.page_size
    const bytes = (pageCount ?? 0) * (pageSize ?? 0)
    if (bytes <= props.maxBytes) return

    const rows = (db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n
    if (rows > 0) {
      const rowsToDrop = Math.min(
        rows,
        Math.ceil((bytes - props.targetBytes) / Math.max(1, bytes / rows)),
      )
      db.prepare(
        "DELETE FROM logs WHERE seq IN (SELECT seq FROM logs ORDER BY seq ASC LIMIT ?)",
      ).run(rowsToDrop)
    }
    db.run("PRAGMA wal_checkpoint(TRUNCATE)")
    db.run("VACUUM")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[leuco] event log maintenance failed: ${message}\n`)
  } finally {
    db?.close()
  }
}
