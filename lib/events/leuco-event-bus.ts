import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { LeucoEvent, LeucoEventListener } from "@/events/leuco-event-types"

type Props = {
  /** Path to the JSONL file events are appended to. Omit to disable persistence. */
  eventLogPath?: string
}

/**
 * In-process event bus. Components call `emit()` to publish a structured
 * `LeucoEvent`; the bus appends to `events.jsonl` and fans out to live
 * subscribers (the gateway SSE feed, the TUI, anyone else). Persistence and
 * subscription are independent — disabling one does not break the other.
 */
export class LeucoEventBus {
  private readonly eventLogPath: string | undefined
  private readonly listeners = new Set<LeucoEventListener>()

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
   * Convenience: emit a structured `log` event onto the bus. Subscribers (the
   * gateway SSE feed, the TUI tail, the events.jsonl writer) handle their own
   * mirroring; this helper exists for components that only have a bus
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

  private persist(event: LeucoEvent): void {
    if (!this.eventLogPath) return
    try {
      const dir = dirname(this.eventLogPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(this.eventLogPath, `${JSON.stringify(event)}\n`)
    } catch {
      // Persistence failures are non-fatal — keep emitting to live subscribers.
    }
  }
}
