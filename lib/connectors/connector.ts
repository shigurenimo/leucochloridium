import type { LeucoEventLog } from "@/events/leuco-event-log"

/** Runtime services exposed to a connector. */
export type TurnPriority = "normal" | "high"

export type RunTextTurnOptions = {
  priority?: TurnPriority
}

export type ConnectorContext = {
  cwd: string
  onLog: (line: string) => void
  runTextTurn: (
    threadKey: string,
    text: string,
    options?: RunTextTurnOptions,
  ) => Promise<string | Error>
  eventLog: LeucoEventLog
  projectName: string
}

export type ConnectorIdentity = {
  name: string
  type: "slack" | "schedule"
  botUserId: string | null
}

export type Connector = {
  readonly name: string
  start(ctx: ConnectorContext): Promise<void>
  stop(): Promise<void>
  getIdentity(): ConnectorIdentity
}
