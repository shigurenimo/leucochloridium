import { Flume, type FlumeRunning, type FlumeSource } from "@interactive-inc/flume"
import { FlumeDiscordSource } from "@interactive-inc/flume/discord"
import {
  DiscordEventSource,
  type DiscordSourceHandlers,
} from "@/connectors/discord/discord-event-source"

type Props = { botToken: string; intents: number; source?: FlumeSource }

/** Gatewayの再接続はflumeに任せ、停止失敗と配送の終了を呼び出し側へ返す。 */
export class FlumeDiscordEventSource extends DiscordEventSource {
  private running: FlumeRunning | null = null
  private controller: AbortController | null = null
  private opening: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private state = "disconnected"
  private cleanupFailure: Error | null = null

  constructor(private readonly props: Props) {
    super()
  }

  start(handlers: DiscordSourceHandlers): Promise<void> {
    if (this.controller !== null || this.closing !== null)
      return Promise.reject(new Error("Discord source already started or stopping"))
    const controller = new AbortController()
    this.controller = controller
    this.opening = this.open(handlers, controller)
    return this.opening
  }

  private async open(handlers: DiscordSourceHandlers, controller: AbortController): Promise<void> {
    const flume = new Flume({
      sources: [
        this.props.source ??
          new FlumeDiscordSource({ token: this.props.botToken, intents: this.props.intents }),
      ],
      signal: controller.signal,
      reconnect: {},
      openTimeoutMs: 35_000,
      onEvent: async (item) => {
        if (controller.signal.aborted) return
        if (item.kind === "event") {
          if (item.event.source === "discord") await handlers.onEvent(item.event)
          return
        }
        if (
          item.log.source === "discord" &&
          item.log.action === "status" &&
          typeof item.log.detail?.to === "string"
        ) {
          this.state = item.log.detail.to
          handlers.onStatus(this.state)
        }
        if (item.log.level !== "debug")
          handlers.onLog(item.log.message.replaceAll(this.props.botToken, "[redacted]"))
      },
    })
    const opened = await flume.open()
    if (opened instanceof Error) {
      const rollback = flume
        .diagnostics()
        .entries.find((entry) => entry.action === "flume.rollback.failed")
      if (rollback !== undefined)
        this.cleanupFailure = new Error("Discord startup cleanup failed", { cause: rollback.error })
      throw new Error("Discord Gateway could not start", { cause: opened })
    }
    this.running = opened
    this.state = opened.statuses()[0]?.status ?? "disconnected"
    if (controller.signal.aborted) throw new Error("Discord source stopped during startup")
  }

  stop(): Promise<void> {
    if (this.closing !== null) return this.closing
    this.controller?.abort()
    this.closing = this.close()
    return this.closing
  }

  private async close(): Promise<void> {
    await this.opening?.catch(() => {})
    if (this.cleanupFailure !== null) throw this.cleanupFailure
    if (this.running !== null) {
      const closed = await this.running.close()
      await this.running.drain()
      if (closed.errors().length > 0)
        throw new AggregateError(
          closed.errors().map((entry) => entry.error),
          "Discord Gateway shutdown failed",
        )
    }
    this.running = null
    this.controller = null
    this.opening = null
    this.closing = null
    this.state = "disconnected"
  }

  status(): string {
    return this.running?.statuses()[0]?.status ?? this.state
  }
}
