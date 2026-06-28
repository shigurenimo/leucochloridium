import { Flume } from "@interactive-inc/flume"
import type {
  FlumeEvent,
  FlumeLog,
  FlumeRunning,
  FlumeSlackEvent,
  FlumeStreamItem,
} from "@interactive-inc/flume"
import { FlumeSlackSource } from "@interactive-inc/flume/slack"
import {
  type LeucoSlackEnvelope,
  LeucoSlackEventSource,
  type LeucoSlackSourceLog,
  type LeucoSlackSourceStatus,
  leucoSlackSourceStatusSchema,
} from "@/channels/slack/leuco-slack-event-source"

type Props = {
  botToken: string
  appToken: string
}

/**
 * `LeucoSlackEventSource` backed by `@interactive-inc/flume` (>= 0.9). The
 * flume types leak no further than this file: the unified firehose
 * (`FlumeStreamItem`) is split back into Leuco's three callbacks
 * (`onEvent` / `onStatus` / `onLog`) so the channel plugin stays decoupled
 * from flume.
 */
export class LeucoFlumeSlackEventSource extends LeucoSlackEventSource {
  private running: FlumeRunning | null = null
  private currentStatus: LeucoSlackSourceStatus = "disconnected"

  constructor(private readonly props: Props) {
    super()
  }

  async start(props: {
    onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>
    onStatus?: (status: LeucoSlackSourceStatus) => void
    onLog?: (log: LeucoSlackSourceLog) => void
  }): Promise<void> {
    const source = new FlumeSlackSource({
      appToken: this.props.appToken,
      botToken: this.props.botToken,
    })

    const onLog = props.onLog
    const flume = new Flume({
      sources: [source],
      // Enable flume's built-in reconnect supervisor. Without this, a single
      // socket-mode disconnect (WiFi blip, Slack-side close, idle timeout)
      // would silently stop event delivery until the daemon is restarted.
      // Defaults: infinite attempts, 1s base, 30s cap, exponential w/ jitter.
      reconnect: {},
      onEvent: (item: FlumeStreamItem) => {
        if (item.kind === "event") {
          this.handleEvent(item.event, props.onEvent, onLog)
          return
        }
        this.handleLog(item.log, onLog, props.onStatus)
      },
    })

    const running = await flume.open()
    if (running instanceof Error) throw running

    this.running = running
  }

  async stop(): Promise<void> {
    const running = this.running
    if (running === null) return
    this.running = null
    await running.close()
    this.currentStatus = "disconnected"
  }

  status(): LeucoSlackSourceStatus {
    return this.currentStatus
  }

  private handleEvent(
    event: FlumeEvent,
    onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
  ): void {
    if (event.source !== "slack") return
    // Catch a rejected handler explicitly so an exception inside the plugin's
    // event pipeline does not become an unhandled rejection — which run.ts
    // treats as a fatal error and terminates the daemon.
    onEvent(toLeucoEnvelope(event)).catch((err: unknown) => {
      if (!onLog) return
      const error = err instanceof Error ? err : new Error(String(err))
      onLog({
        level: "error",
        action: "event.handler.failed",
        message: error.message,
        error,
        detail: null,
        timestamp: Date.now(),
      })
    })
  }

  private handleLog(
    log: FlumeLog,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
    onStatus: ((status: LeucoSlackSourceStatus) => void) | undefined,
  ): void {
    const status = extractStatus(log)
    if (status !== null) {
      this.currentStatus = status
      if (onStatus) onStatus(status)
    }
    if (onLog) onLog(toLeucoLog(log))
  }
}

const toLeucoEnvelope = (event: FlumeSlackEvent): LeucoSlackEnvelope => {
  return {
    type: event.type,
    payload: event.data,
    receivedAt: event.receivedAt,
  }
}

const toLeucoLog = (log: FlumeLog): LeucoSlackSourceLog => {
  return {
    level: log.level,
    action: log.action,
    message: log.message,
    error: log.error ?? null,
    detail: log.detail ?? null,
    timestamp: log.timestamp,
  }
}

const extractStatus = (log: FlumeLog): LeucoSlackSourceStatus | null => {
  if (log.action !== "status") return null
  const to = log.detail?.to
  const parsed = leucoSlackSourceStatusSchema.safeParse(to)
  return parsed.success ? parsed.data : null
}
