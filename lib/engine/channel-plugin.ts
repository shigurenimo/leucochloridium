import type { LeucoEventBus } from "@/events/leuco-event-bus"

export type ChannelPluginContext = {
  cwd: string
  onLog: (line: string) => void
  /** Submit a text turn to the underlying agent and resolve to its reply. */
  runTextTurn: (threadKey: string, text: string) => Promise<string>
  /** Structured event emitter (events.jsonl + live subscribers). */
  bus: LeucoEventBus
  /** Identity of the tenant the plugin is wired for, attached to events. */
  projectName: string
  agentName: string
}

/**
 * Plugin self-description used by the system prompt builder. `botUserId` is
 * null until the plugin's underlying transport is connected (Slack), or
 * always null for transports that have no remote identity (schedule).
 */
export type ChannelIdentity = {
  name: string
  type: "slack" | "schedule"
  botUserId: string | null
}

export type ChannelPlugin = {
  /** Stable identifier — matches `settings.channels[].name`. */
  readonly name: string
  start(ctx: ChannelPluginContext): Promise<void>
  stop(): Promise<void>
  getIdentity(): ChannelIdentity
}
