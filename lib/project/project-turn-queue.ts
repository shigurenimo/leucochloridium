import { Buffer } from "node:buffer"
import type { RunTextTurnOptions, TurnPriority } from "@/connectors/connector"
import type { LeucoEventLog } from "@/events/leuco-event-log"

export type QueuedProjectTurn = {
  threadKey: string
  text: string
  enqueuedAt: number
  priority: TurnPriority
}

type PendingProjectTurn = QueuedProjectTurn & {
  resolve: (reply: string | Error) => void
}

type TurnRejectionReason = "runtime_stopped" | "queue_count_limit" | "queue_bytes_limit"

type TurnAdmissionRejection = {
  error: Error
  reason: TurnRejectionReason
}

export type ProjectTurnQueueProps = {
  projectName: string
  concurrency: number
  maxItems: number
  maxBytes: number
  conversationKey: (threadKey: string) => string
  execute: (turn: QueuedProjectTurn) => Promise<string | Error>
  onLog: (line: string) => void
  eventLog: LeucoEventLog
}

/**
 * Bounds and schedules project turns while preserving ordering per
 * conversation. High-priority addressed work may displace queued ambient
 * work, but an active turn is never interrupted.
 */
export class ProjectTurnQueue {
  private readonly projectName: string
  private readonly concurrency: number
  private readonly maxItems: number
  private readonly maxBytes: number
  private readonly conversationKey: (threadKey: string) => string
  private readonly execute: (turn: QueuedProjectTurn) => Promise<string | Error>
  private readonly log: (line: string) => void
  private readonly eventLog: LeucoEventLog
  private pending: PendingProjectTurn[] = []
  private pendingBytes = 0
  private readonly activeKeys = new Set<string>()
  private activeCount = 0
  private stopped = false

  constructor(props: ProjectTurnQueueProps) {
    this.projectName = props.projectName
    this.concurrency = props.concurrency
    this.maxItems = props.maxItems
    this.maxBytes = props.maxBytes
    this.conversationKey = props.conversationKey
    this.execute = props.execute
    this.log = props.onLog
    this.eventLog = props.eventLog
  }

  start(): void {
    this.stopped = false
    this.drain()
  }

  stop(): void {
    this.stopped = true
    const cancelled = this.pending.splice(0)
    this.pendingBytes = 0
    const error = new Error(`project runtime ${this.projectName} is stopping`)
    for (const turn of cancelled) turn.resolve(error)
  }

  enqueue(
    threadKey: string,
    text: string,
    options: RunTextTurnOptions = {},
  ): Promise<string | Error> {
    const inputBytes = Buffer.byteLength(text, "utf8")
    const priority = options.priority ?? "normal"
    if (priority === "high" && !this.stopped && inputBytes <= this.maxBytes) {
      this.makeRoomForHighPriorityTurn(inputBytes)
    }

    const rejection = this.admissionRejection(inputBytes)
    if (rejection !== null) {
      this.emitRejected(threadKey, rejection.reason, inputBytes)
      return Promise.resolve(rejection.error)
    }

    return new Promise<string | Error>((resolve) => {
      const queueDepth = this.pending.length + 1
      const queueBytes = this.pendingBytes + inputBytes
      const key = this.conversationKey(threadKey)
      const willQueue =
        this.pending.length > 0 || this.activeCount >= this.concurrency || this.activeKeys.has(key)

      if (willQueue) {
        this.log(`[leuco] ${this.projectName}: turn queued (pending=${queueDepth})`)
        this.eventLog.append({
          ts: Date.now(),
          type: "turn.queued",
          project: this.projectName,
          threadKey,
          queueDepth,
          queueBytes,
        })
      }

      this.pendingBytes = queueBytes
      const pending = {
        threadKey,
        text,
        enqueuedAt: Date.now(),
        priority,
        resolve,
      }
      const firstNormal = this.pending.findIndex((candidate) => candidate.priority === "normal")
      if (priority === "high" && firstNormal >= 0) {
        this.pending.splice(firstNormal, 0, pending)
      } else {
        this.pending.push(pending)
      }
      this.drain()
    })
  }

  private makeRoomForHighPriorityTurn(inputBytes: number): void {
    while (this.pending.length >= this.maxItems || this.pendingBytes + inputBytes > this.maxBytes) {
      const normalIndex = this.pending.findLastIndex((candidate) => candidate.priority === "normal")
      if (normalIndex < 0) return

      const evicted = this.pending.splice(normalIndex, 1)[0]
      if (evicted === undefined) return
      const evictedBytes = Buffer.byteLength(evicted.text, "utf8")
      this.pendingBytes = Math.max(0, this.pendingBytes - evictedBytes)
      const reason: TurnRejectionReason =
        this.pending.length + 1 >= this.maxItems ? "queue_count_limit" : "queue_bytes_limit"
      this.emitRejected(evicted.threadKey, reason, evictedBytes)
      evicted.resolve(
        new Error(
          `project runtime ${this.projectName} deferred turn was superseded by addressed work`,
        ),
      )
    }
  }

  private drain(): void {
    if (this.stopped) return

    let index = 0
    while (this.activeCount < this.concurrency && index < this.pending.length) {
      const pending = this.pending[index]!
      const key = this.conversationKey(pending.threadKey)
      if (this.activeKeys.has(key)) {
        index += 1
        continue
      }

      this.pending.splice(index, 1)
      this.pendingBytes = Math.max(0, this.pendingBytes - Buffer.byteLength(pending.text, "utf8"))
      this.activeKeys.add(key)
      this.activeCount += 1

      void this.execute(pending)
        .catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
        .then((reply) => pending.resolve(reply))
        .finally(() => {
          this.activeKeys.delete(key)
          this.activeCount -= 1
          this.drain()
        })
    }
  }

  private admissionRejection(queuedBytes: number): TurnAdmissionRejection | null {
    if (this.stopped) {
      return {
        error: new Error(`project runtime ${this.projectName} is stopping`),
        reason: "runtime_stopped",
      }
    }
    if (this.pending.length >= this.maxItems) {
      return {
        error: new Error(
          `project runtime ${this.projectName} turn queue is full (${this.maxItems} pending)`,
        ),
        reason: "queue_count_limit",
      }
    }
    if (this.pendingBytes + queuedBytes > this.maxBytes) {
      return {
        error: new Error(
          `project runtime ${this.projectName} turn queue exceeds ${this.maxBytes} UTF-8 bytes`,
        ),
        reason: "queue_bytes_limit",
      }
    }
    return null
  }

  private emitRejected(threadKey: string, reason: TurnRejectionReason, inputBytes: number): void {
    this.eventLog.append({
      ts: Date.now(),
      type: "turn.rejected",
      project: this.projectName,
      threadKey,
      reason,
      queueDepth: this.pending.length,
      queueBytes: this.pendingBytes,
      inputBytes,
      maxQueueDepth: this.maxItems,
      maxQueueBytes: this.maxBytes,
    })
  }
}
