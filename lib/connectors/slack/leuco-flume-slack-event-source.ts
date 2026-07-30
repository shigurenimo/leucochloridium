import { Flume } from "@interactive-inc/flume"
import type {
  FlumeEvent,
  FlumeLog,
  FlumeRunning,
  FlumeSlackEvent,
  FlumeStreamItem,
} from "@interactive-inc/flume"
import { FlumeSlackSource } from "@interactive-inc/flume/slack"
import { LeucoNodeSlackWakeClock } from "@/connectors/slack/leuco-node-slack-wake-clock"
import { LeucoSlackWakeClock } from "@/connectors/slack/leuco-slack-wake-clock"
import {
  type LeucoSlackEnvelope,
  LeucoSlackEventSource,
  type LeucoSlackSourceLog,
  type LeucoSlackSourceStatus,
  leucoSlackSourceStatusSchema,
} from "@/connectors/slack/leuco-slack-event-source"

export type LeucoFlumeSlackEventSourceProps = {
  botToken: string
  appToken: string
  startTimeoutMs?: number
  /** How often to check for a wall-clock jump caused by host suspension. */
  wakeCheckIntervalMs?: number
  /** Extra delay beyond one normal check that is treated as host suspension. */
  wakeDriftThresholdMs?: number
  /** Clock/timer injection for deterministic lifecycle tests. */
  wakeClock?: LeucoSlackWakeClock
}

type StartProps = {
  onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>
  onStatus?: (status: LeucoSlackSourceStatus) => void
  onLog?: (log: LeucoSlackSourceLog) => void
}

type SlackSession = {
  controller: AbortController
  running: FlumeRunning | null
  dispose: () => void
}

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_WAKE_CHECK_INTERVAL_MS = 30_000
const DEFAULT_WAKE_DRIFT_THRESHOLD_MS = 60_000
const SYSTEM_WAKE_CLOCK = new LeucoNodeSlackWakeClock()

/**
 * `LeucoSlackEventSource` backed by `@interactive-inc/flume` (>= 0.9). The
 * flume types leak no further than this file: the unified firehose
 * (`FlumeStreamItem`) is split back into Leuco's three callbacks
 * (`onEvent` / `onStatus` / `onLog`) so the Slack connector stays decoupled
 * from flume.
 */
export class LeucoFlumeSlackEventSource extends LeucoSlackEventSource {
  private lifecycleController: AbortController | null = null
  private session: SlackSession | null = null
  private currentStatus: LeucoSlackSourceStatus = "disconnected"
  private wakeTimerCancel: (() => void) | null = null
  private wakeLastCheckAt = 0
  private wakeReconnectNeeded = false
  private wakeReconnectPromise: Promise<void> | null = null
  private readonly startTimeoutMs: number
  private readonly wakeCheckIntervalMs: number
  private readonly wakeDriftThresholdMs: number
  private readonly wakeClock: LeucoSlackWakeClock

  constructor(private readonly props: LeucoFlumeSlackEventSourceProps) {
    super()
    this.startTimeoutMs = positiveInteger(
      "startTimeoutMs",
      props.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    )
    this.wakeCheckIntervalMs = positiveInteger(
      "wakeCheckIntervalMs",
      props.wakeCheckIntervalMs ?? DEFAULT_WAKE_CHECK_INTERVAL_MS,
    )
    this.wakeDriftThresholdMs = positiveInteger(
      "wakeDriftThresholdMs",
      props.wakeDriftThresholdMs ?? DEFAULT_WAKE_DRIFT_THRESHOLD_MS,
    )
    this.wakeClock = props.wakeClock ?? SYSTEM_WAKE_CLOCK
  }

  async start(props: StartProps): Promise<void> {
    if (this.lifecycleController !== null) {
      throw new Error("Slack event source is already started or starting")
    }

    const controller = new AbortController()
    this.lifecycleController = controller
    const session = this.createSession(controller)
    this.session = session

    try {
      const running = await this.openSession(session, props)
      if (controller.signal.aborted || this.lifecycleController !== controller) {
        session.running = running
        await this.closeSession(session).catch(() => undefined)
        throw abortError(controller.signal)
      }
      session.running = running
      this.armWakeWatchdog(controller, props)
    } catch (error) {
      if (this.session === session) {
        this.session = null
        await this.closeSession(session).catch(() => undefined)
      }
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
    this.disarmWakeWatchdog()
    this.wakeReconnectNeeded = false
    if (controller !== null && !controller.signal.aborted) {
      controller.abort(new Error("Slack event source start cancelled"))
    }

    const session = this.session
    this.session = null
    const wakeReconnectPromise = this.wakeReconnectPromise
    this.currentStatus = "disconnected"

    let closeError: unknown = null
    if (session !== null) {
      try {
        await this.closeSession(session)
      } catch (error) {
        closeError = error
      }
    }
    if (wakeReconnectPromise !== null) await wakeReconnectPromise
    if (closeError !== null) throw closeError
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

  private createSession(lifecycleController: AbortController): SlackSession {
    const controller = new AbortController()
    const onLifecycleAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(abortError(lifecycleController.signal))
      }
    }
    if (lifecycleController.signal.aborted) {
      onLifecycleAbort()
    } else {
      lifecycleController.signal.addEventListener("abort", onLifecycleAbort, { once: true })
    }
    return {
      controller,
      running: null,
      dispose: () => lifecycleController.signal.removeEventListener("abort", onLifecycleAbort),
    }
  }

  private async openSession(session: SlackSession, props: StartProps): Promise<FlumeRunning> {
    const flume = this.buildFlume(props, session.controller)
    return await this.openWithinDeadline(flume, session.controller, props.onLog)
  }

  private async closeSession(session: SlackSession): Promise<void> {
    session.dispose()
    if (!session.controller.signal.aborted) {
      session.controller.abort(new Error("Slack socket session replaced"))
    }
    const running = session.running
    session.running = null
    if (running !== null) await running.close()
  }

  private async openWithinDeadline(
    flume: Flume,
    controller: AbortController,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
  ): Promise<FlumeRunning> {
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`Slack event source start timed out after ${this.startTimeoutMs}ms`),
      )
    }, this.startTimeoutMs)
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

  private armWakeWatchdog(controller: AbortController, props: StartProps): void {
    this.disarmWakeWatchdog()
    this.wakeLastCheckAt = this.wakeClock.now()
    try {
      this.wakeTimerCancel = this.wakeClock.setInterval(() => {
        this.checkForWake(controller, props)
      }, this.wakeCheckIntervalMs)
    } catch (error) {
      const normalized = normalizeError(error)
      this.emitSourceLog(props.onLog, {
        level: "error",
        action: "wake.watchdog.schedule.failed",
        message: normalized.message,
        error: normalized,
        detail: null,
        timestamp: this.wakeClock.now(),
      })
    }
  }

  private disarmWakeWatchdog(): void {
    if (this.wakeTimerCancel === null) return
    const cancel = this.wakeTimerCancel
    this.wakeTimerCancel = null
    try {
      cancel()
    } catch {
      // Stopping the socket must continue even if an injected/runtime timer
      // implementation refuses to clear an already-fired handle.
    }
  }

  private checkForWake(controller: AbortController, props: StartProps): void {
    if (controller.signal.aborted || this.lifecycleController !== controller) return

    const now = this.wakeClock.now()
    const elapsedMs = now - this.wakeLastCheckAt
    this.wakeLastCheckAt = now
    const driftMs = elapsedMs - this.wakeCheckIntervalMs
    if (driftMs >= this.wakeDriftThresholdMs) {
      this.wakeReconnectNeeded = true
      this.emitSourceLog(props.onLog, {
        level: "warn",
        action: "wake.detected",
        message: `event loop resumed after ${elapsedMs}ms; rebuilding Slack socket`,
        error: null,
        detail: { elapsedMs, driftMs },
        timestamp: now,
      })
    }
    if (this.wakeReconnectNeeded) this.requestWakeReconnect(controller, props)
  }

  private requestWakeReconnect(controller: AbortController, props: StartProps): void {
    if (this.wakeReconnectPromise !== null) return

    const reconnecting = this.reconnectAfterWake(controller, props).catch((error: unknown) => {
      if (controller.signal.aborted || this.lifecycleController !== controller) return
      const normalized = normalizeError(error)
      this.wakeReconnectNeeded = true
      this.currentStatus = "disconnected"
      props.onStatus?.("disconnected")
      this.emitSourceLog(props.onLog, {
        level: "error",
        action: "wake.reconnect.failed",
        message: normalized.message,
        error: normalized,
        detail: null,
        timestamp: this.wakeClock.now(),
      })
    })
    this.wakeReconnectPromise = reconnecting
    void reconnecting.finally(() => {
      if (this.wakeReconnectPromise === reconnecting) this.wakeReconnectPromise = null
    })
  }

  private async reconnectAfterWake(controller: AbortController, props: StartProps): Promise<void> {
    this.currentStatus = "reconnecting"
    props.onStatus?.("reconnecting")

    const previous = this.session
    if (previous !== null) {
      this.session = null
      try {
        await this.closeSession(previous)
      } catch (error) {
        const normalized = normalizeError(error)
        this.emitSourceLog(props.onLog, {
          level: "error",
          action: "wake.close.failed",
          message: normalized.message,
          error: normalized,
          detail: null,
          timestamp: this.wakeClock.now(),
        })
      }
    }
    if (controller.signal.aborted || this.lifecycleController !== controller) return

    const next = this.createSession(controller)
    this.session = next
    try {
      const running = await this.openSession(next, props)
      if (controller.signal.aborted || this.lifecycleController !== controller) {
        next.running = running
        await this.closeSession(next).catch(() => undefined)
        return
      }
      next.running = running
      this.wakeReconnectNeeded = false
      this.emitSourceLog(props.onLog, {
        level: "info",
        action: "wake.reconnected",
        message: "Slack socket rebuilt after host resume",
        error: null,
        detail: null,
        timestamp: this.wakeClock.now(),
      })
    } catch (error) {
      if (this.session === next) this.session = null
      await this.closeSession(next).catch(() => undefined)
      throw error
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
    // Catch a rejected handler explicitly so an exception inside the connector's
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

  private emitSourceLog(
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
    log: LeucoSlackSourceLog,
  ): void {
    if (onLog) onLog(log)
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

const positiveInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

const normalizeError = (error: unknown): Error => {
  return error instanceof Error ? error : new Error(String(error))
}
