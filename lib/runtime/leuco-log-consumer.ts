import type { LeucoEventLog } from "@/events/leuco-event-log"
import type { LogLevel } from "@/log-level"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorDetails } from "@/error-details"

/** A host observer cannot replay a log, stall shutdown or reject outside its delivery boundary. */
export class LeucoLogConsumer {
  private readonly pending = new Set<Promise<void>>()
  private readonly state: {
    accepting: boolean
    healthy: boolean
    failureVersion: number
    lastFailure: {
      ts: number
      requestId: string | null
      message: string
      causes: ReturnType<typeof errorDetails>
    } | null
  } = { accepting: true, healthy: true, failureVersion: 0, lastFailure: null }

  constructor(
    private readonly props: {
      eventLog: LeucoEventLog
      onLog?: (line: string, level?: LogLevel, requestId?: string) => unknown
    },
  ) {
    Object.freeze(this)
  }

  write(line: string, level: LogLevel, requestId: string | null): void {
    if (!this.state.accepting || this.props.onLog === undefined) return
    if (this.pending.size >= 64) {
      this.recordFailure(
        new Error(
          "Log consumer has 64 unconfirmed deliveries; delivery was not attempted, inspect structured events",
        ),
        requestId,
      )
      return
    }
    const version = this.state.failureVersion
    try {
      const delivered = this.props.onLog(line, level, requestId ?? undefined)
      if (
        delivered === null ||
        (typeof delivered !== "object" && typeof delivered !== "function") ||
        typeof Reflect.get(delivered, "then") !== "function"
      ) {
        if (this.state.failureVersion === version) this.state.healthy = true
        return
      }
      const observed = awaitBoundedCleanup(Promise.resolve(delivered), "Runtime log consumer", 1000)
        .then(
          () => {
            if (this.state.failureVersion === version) this.state.healthy = true
          },
          (error: unknown) => {
            this.recordFailure(error, requestId)
          },
        )
        .finally(() => {
          this.pending.delete(observed)
        })
      this.pending.add(observed)
    } catch (error) {
      this.recordFailure(error, requestId)
    }
  }

  private recordFailure(error: unknown, requestId: string | null): void {
    const safe = this.props.eventLog.redactError(error)
    this.state.healthy = false
    this.state.failureVersion += 1
    this.state.lastFailure = {
      ts: Date.now(),
      requestId,
      message: safe.message,
      causes: errorDetails(safe),
    }
    this.props.eventLog.error(`Log consumer failed: ${safe.message}`, safe, requestId ?? undefined)
  }

  getHealth() {
    return {
      healthy: this.state.healthy,
      pending: this.pending.size,
      maxPending: 64,
      lastFailure:
        this.state.lastFailure === null
          ? null
          : {
              ...this.state.lastFailure,
              causes: this.state.lastFailure.causes.map((cause) => ({ ...cause })),
            },
    }
  }

  async close(): Promise<void> {
    this.state.accepting = false
    await Promise.allSettled(this.pending)
  }
}
