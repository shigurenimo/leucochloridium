import type { LeucoEventJournal } from "@/events/leuco-event-journal"

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
  journal: LeucoEventJournal
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
