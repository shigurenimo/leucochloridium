import type { LeucoEventBus } from "@/events/leuco-event-bus"

export type ChannelPluginContext = {
  cwd: string
  onLog: (line: string) => void
  runTextTurn: (threadKey: string, text: string) => Promise<string | Error>
  bus: LeucoEventBus
  projectName: string
}

export type ChannelIdentity = {
  name: string
  type: "slack" | "schedule"
  botUserId: string | null
}

export type ChannelPlugin = {
  readonly name: string
  start(ctx: ChannelPluginContext): Promise<void>
  stop(): Promise<void>
  getIdentity(): ChannelIdentity
}
