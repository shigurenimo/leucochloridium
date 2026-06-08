import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs"
import { dirname } from "node:path"
import { errorMessage } from "@/error-message"
import type { LeucoEvent, LeucoEventListener } from "@/events/leuco-event-types"

type Props = {
  /** Path to the JSONL file events are appended to. Omit to disable persistence. */
  eventLogPath?: string
}

/**
 * In-process event bus. Components call `emit()` to publish a structured
 * `LeucoEvent`; the bus appends to `events.jsonl` and fans out to live
 * subscribers (the gateway SSE feed, `leuco logs -f`, anyone else).
 * Persistence and subscription are independent — disabling one does not
 * break the other.
 *
 * Persistence runs through a lazily-opened append `WriteStream` so high-volume
 * codex notification bursts do not pay an open/write/close syscall each. The
 * stream's internal queue preserves write order; `stop()` flushes and closes
 * it. A failure to open or write disables persistence for the bus lifetime
 * but never derails fan-out.
 */
export class LeucoEventBus {
  private readonly eventLogPath: string | undefined
  private readonly listeners = new Set<LeucoEventListener>()
  private writeStream: WriteStream | null = null
  private persistenceDisabled = false

  constructor(props: Props = {}) {
    this.eventLogPath = props.eventLogPath
  }

  emit(event: LeucoEvent): void {
    this.persist(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // a faulty subscriber must not derail emission for everyone else
      }
    }
  }

  /**
   * Convenience: emit a structured `log` event onto the bus. Subscribers
   * (gateway SSE feed, `leuco logs -f`, events.jsonl writer) handle their
   * own mirroring; this helper exists for components that only have a bus
   * reference and no `onLog` callback.
   */
  log(level: "info" | "warn" | "error", line: string): void {
    this.emit({ ts: Date.now(), type: "log", level, line })
  }

  subscribe(listener: LeucoEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Flush pending writes and close the underlying append stream. Idempotent
   * so the engine can call it during shutdown without tracking whether the
   * stream was ever opened.
   */
  async stop(): Promise<void> {
    const stream = this.writeStream
    if (stream === null) return
    this.writeStream = null
    await new Promise<void>((resolve) => {
      stream.end(() => resolve())
    })
  }

  private persist(event: LeucoEvent): void {
    if (!this.eventLogPath || this.persistenceDisabled) return
    const stream = this.openStream(this.eventLogPath)
    if (stream === null) return
    stream.write(`${JSON.stringify(event)}\n`)
  }

  private openStream(path: string): WriteStream | null {
    if (this.writeStream !== null) return this.writeStream
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const stream = createWriteStream(path, { flags: "a" })
      stream.on("error", (err) => {
        // Surface the disablement once so a disk-full / EACCES failure
        // doesn't manifest as `leuco logs -f` silently going dark for the
        // rest of the daemon's lifetime.
        process.stderr.write(`[leuco] events.jsonl write disabled: ${err.message}\n`)
        this.persistenceDisabled = true
        this.writeStream = null
      })
      this.writeStream = stream
      return stream
    } catch (error) {
      process.stderr.write(`[leuco] events.jsonl open failed (${path}): ${errorMessage(error)}\n`)
      this.persistenceDisabled = true
      return null
    }
  }
}
