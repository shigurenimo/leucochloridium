import type { LeucoEventLog } from "@/events/leuco-event-log"
import type { LogLevel } from "@/log-level"
import type { LogDeliveryHealth } from "@/log-delivery-health-schema"

/** Runtime services exposed to a connector. */
export type ConnectorContext = {
  onLog: (line: string, level?: LogLevel, requestId?: string) => void
  /** Mirror an already-recorded structured event without appending another history row. */
  onTextLog?: (line: string, level?: LogLevel, requestId?: string) => void
  runTextTurn: (threadKey: string, text: string, requestId?: string) => Promise<string | Error>
  eventLog: LeucoEventLog
}

export type ConnectorIdentity = {
  name: string
  type: "slack" | "discord" | "schedule"
  botUserId: string | null
}

type ConnectorStatus = {
  cleanup?: { pending: number; nextRetryAt: number | null }
  diagnostics?: LogDeliveryHealth
  state: string
  lastActivityAt: number | null
  lastFailure: { ts: number; message: string } | null
}

export type Connector = {
  readonly name: string
  start(ctx: ConnectorContext): Promise<void>
  stop(): Promise<void>
  getStatus?(): ConnectorStatus
  getIdentity(): ConnectorIdentity
}
