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

export type LeucoFlumeSlackEventSourceProps = {
  botToken: string
  appToken: string
  startTimeoutMs?: number
}

type StartProps = {
  onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>
  onStatus?: (status: LeucoSlackSourceStatus) => void
  onLog?: (log: LeucoSlackSourceLog) => void
}

const DEFAULT_START_TIMEOUT_MS = 30_000

/**
 * `LeucoSlackEventSource` backed by `@interactive-inc/flume` (>= 0.9). The
 * flume types leak no further than this file: the unified firehose
 * (`FlumeStreamItem`) is split back into Leuco's three callbacks
 * (`onEvent` / `onStatus` / `onLog`) so the channel plugin stays decoupled
 * from flume.
 */
export class LeucoFlumeSlackEventSource extends LeucoSlackEventSource {
  private running: FlumeRunning | null = null
  private lifecycleController: AbortController | null = null
  private currentStatus: LeucoSlackSourceStatus = "disconnected"

  constructor(private readonly props: LeucoFlumeSlackEventSourceProps) {
    super()
    const startTimeoutMs = props.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs <= 0) {
      throw new Error("startTimeoutMs must be a positive integer")
    }
  }

  async start(props: StartProps): Promise<void> {
    if (this.lifecycleController !== null) {
      throw new Error("Slack event source is already started or starting")
    }

    const controller = new AbortController()
    this.lifecycleController = controller

    try {
      const flume = this.buildFlume(props, controller)
      const running = await this.openWithinDeadline(flume, controller, props.onLog)
      if (controller.signal.aborted || this.lifecycleController !== controller) {
        void running.close().catch(() => undefined)
        throw abortError(controller.signal)
      }
      this.running = running
    } catch (error) {
      if (this.lifecycleController === controller) {
        this.lifecycleController = null
        this.currentStatus = "disconnected"
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const controller = this.lifecycleController
    this.lifecycleController = null
    if (controller !== null && !controller.signal.aborted) {
      controller.abort(new Error("Slack event source start cancelled"))
    }

    const running = this.running
    this.running = null
    this.currentStatus = "disconnected"
    if (running === null) return

    await running.close()
  }

  status(): LeucoSlackSourceStatus {
    return this.currentStatus
  }

  private buildFlume(props: StartProps, controller: AbortController): Flume {
    const source = new FlumeSlackSource({
      appToken: this.props.appToken,
      botToken: this.props.botToken,
      // Do not set idleTimeoutMs. Flume measures application-level frames,
      // which a healthy but quiet Slack workspace does not guarantee.
    })

    const onLog = props.onLog
    return new Flume({
      sources: [source],
      signal: controller.signal,
      // Enable flume's built-in reconnect supervisor. Without this, a single
      // socket-mode disconnect (WiFi blip or Slack-side close)
      // would silently stop event delivery until the daemon is restarted.
      // Defaults: infinite attempts, 1s base, 30s cap, exponential w/ jitter.
      reconnect: {},
      onEvent: (item: FlumeStreamItem) => {
        if (controller.signal.aborted) return
        if (item.kind === "event") {
          this.handleEvent(item.event, props.onEvent, onLog)
          return
        }
        this.handleLog(item.log, onLog, props.onStatus)
      },
    })
  }

  private async openWithinDeadline(
    flume: Flume,
    controller: AbortController,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
  ): Promise<FlumeRunning> {
    const timeoutMs = this.props.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Slack event source start timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const aborted = waitForAbort(controller.signal)
    const opened = flume.open()
    void opened.then(
      (running) => this.closeLateOpen(running, controller, onLog),
      () => undefined,
    )
    try {
      const running = await Promise.race([opened, aborted.promise])
      if (running instanceof Error) throw running
      return running
    } finally {
      clearTimeout(timeout)
      aborted.dispose()
    }
  }

  private closeLateOpen(
    running: FlumeRunning | Error,
    controller: AbortController,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
  ): void {
    if (running instanceof Error || !controller.signal.aborted) return

    void running.close().catch((error: unknown) => {
      if (!onLog) return
      const normalized = error instanceof Error ? error : new Error(String(error))
      onLog({
        level: "error",
        action: "open.late-close.failed",
        message: normalized.message,
        error: normalized,
        detail: null,
        timestamp: Date.now(),
      })
    })
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

const waitForAbort = (signal: AbortSignal): { promise: Promise<never>; dispose: () => void } => {
  const deferred = Promise.withResolvers<never>()
  const onAbort = (): void => deferred.reject(abortError(signal))
  signal.addEventListener("abort", onAbort, { once: true })
  return {
    promise: deferred.promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  }
}

const abortError = (signal: AbortSignal): Error => {
  return signal.reason instanceof Error ? signal.reason : new Error("Slack event source aborted")
}
