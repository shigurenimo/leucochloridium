import {
  type DiscordEnvelope,
  DiscordEventSource,
  type DiscordSourceHandlers,
  type DiscordSourceLog,
} from "@/connectors/discord/discord-event-source"

/** `DiscordEventSource` のテスト用実装。`start` 後に `emit(envelope)` でGatewayのイベントを流す。 */
export class MemoryDiscordEventSource extends DiscordEventSource {
  private handlers: DiscordSourceHandlers | null = null

  async start(handlers: DiscordSourceHandlers): Promise<void> {
    this.handlers = handlers
  }

  async stop(): Promise<void> {
    this.handlers = null
  }

  status(): string {
    return this.handlers === null ? "disconnected" : "connected"
  }

  async emit(envelope: DiscordEnvelope): Promise<void> {
    const handlers = this.handlers
    if (handlers === null) return
    await handlers.onEvent(envelope)
  }

  emitLog(log: DiscordSourceLog): void {
    this.handlers?.onLog(log)
  }
}
