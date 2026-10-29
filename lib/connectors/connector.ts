import type { LeucoEventLog } from "@/events/leuco-event-log"

/** Runtime services exposed to a connector. */
export type ConnectorContext = {
  cwd: string
  onLog: (line: string) => void
  runTextTurn: (threadKey: string, text: string, requestId?: string) => Promise<string | Error>
  eventLog: LeucoEventLog
  runtimeName: string
}

export type ConnectorIdentity = {
  name: string
  type: "slack" | "schedule"
  botUserId: string | null
}

export type ConnectorStatus = {
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
