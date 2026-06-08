import { FunnelLog, FunnelLogSqliteSink } from "@interactive-inc/claude-funnel/logger"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEvent, LeucoEventListener } from "@/events/leuco-event-types"

type Props = {
  eventLogPath?: string
  now?: () => number
}

export class LeucoEventBus {
  private readonly eventLog: FunnelLog<LeucoEvent> | null
  private readonly sink: FunnelLogSqliteSink<LeucoEvent, ["project"]> | null
  private readonly listeners = new Set<LeucoEventListener>()

  constructor(props: Props = {}) {
    if (props.eventLogPath) {
      this.sink = new FunnelLogSqliteSink<LeucoEvent, ["project"]>({
        path: props.eventLogPath,
        indexes: ["project"],
        extractIndexes: (event) => ({
          project: "project" in event && typeof event.project === "string" ? event.project : null,
        }),
        now: props.now,
        maxRows: 50_000,
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
    if (this.eventLog) {
      const result = this.eventLog.emit(event)

      if (result instanceof Error) {
        process.stderr.write(`[leuco] event persist failed: ${result.message}\n`)
      }
    }

    for (const listener of this.listeners) {
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
    if (this.eventLog) this.eventLog.close()
  }
}
