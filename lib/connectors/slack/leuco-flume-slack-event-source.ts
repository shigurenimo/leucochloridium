import { redactPublicText } from "@/secrets/redact-public-text"
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
  closing: Promise<void> | null
  dispose: () => void
}

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_WAKE_CHECK_INTERVAL_MS = 30_000
const DEFAULT_WAKE_DRIFT_THRESHOLD_MS = 60_000
const SYSTEM_WAKE_CLOCK = new LeucoNodeSlackWakeClock()

/**
 * `LeucoSlackEventSource` backed by `@interactive-inc/flume` (0.12). The
 * flume types leak no further than this file: the unified firehose
 * (`FlumeStreamItem`) is split back into Leuco's three callbacks
 * (`onEvent` / `onStatus` / `onLog`) so the Slack connector stays decoupled
 * from flume.
 */
export class LeucoFlumeSlackEventSource extends LeucoSlackEventSource {
  private lifecycleController: AbortController | null = null
  private session: SlackSession | null = null
  private sourceLog: StartProps["onLog"] = undefined
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

    if (this.session !== null || this.wakeTimerCancel !== null)
      throw new Error(
        "Previous Slack cleanup is unconfirmed; inspect its errors and finish shutdown before opening another session",
      )
    this.sourceLog = props.onLog
    const controller = new AbortController()
    this.lifecycleController = controller
    const session = this.createSession(controller)
    this.session = session

    try {
      const running = await this.openSession(session, props)
      if (controller.signal.aborted || this.lifecycleController !== controller) {
        session.running = running
        throw abortError(controller.signal)
      }
      session.running = running
      this.armWakeWatchdog(controller, props)
    } catch (error) {
      const failures: unknown[] = [error]
      if (this.session === session) {
        try {
          await this.closeSession(session)
          this.session = null
        } catch (cleanup) {
          failures.push(cleanup)
          this.reportFailure(props.onLog, "start.cleanup.failed", cleanup)
        }
      }
      if (this.lifecycleController === controller) {
        this.lifecycleController = null
        this.currentStatus = "disconnected"
      }
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          `Slack startup failed: ${normalizeError(error).message}; cleanup also failed`,
          { cause: error },
        )
      throw error
    }
  }

  async stop(): Promise<void> {
    const controller = this.lifecycleController
    this.lifecycleController = null
    const watchdogError = this.disarmWakeWatchdog()
    const failures: unknown[] = watchdogError === null ? [] : [watchdogError]
    this.wakeReconnectNeeded = false
    if (controller !== null && !controller.signal.aborted)
      controller.abort(new Error("Slack event source start cancelled"))
    const session = this.session
    const wakeReconnectPromise = this.wakeReconnectPromise
    this.currentStatus = "disconnected"
    if (session !== null) {
      try {
        await this.closeSession(session)
        if (this.session === session) this.session = null
      } catch (error) {
        failures.push(error)
      }
    }
    if (wakeReconnectPromise !== null) {
      try {
        await wakeReconnectPromise
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Slack shutdown failed; inspect socket and watchdog causes",
        { cause: failures[0] },
      )
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
      closing: null,
      dispose: () => lifecycleController.signal.removeEventListener("abort", onLifecycleAbort),
    }
  }

  private async openSession(session: SlackSession, props: StartProps): Promise<FlumeRunning> {
    const flume = this.buildFlume(props, session.controller)
    return await this.openWithinDeadline(flume, session, props.onLog)
  }

  private async closeSession(session: SlackSession): Promise<void> {
    if (session.closing !== null) return session.closing
    session.dispose()
    if (!session.controller.signal.aborted)
      session.controller.abort(new Error("Slack socket session replaced"))
    const running = session.running
    if (running === null) return
    const closing = Promise.resolve()
      .then(() => running.close())
      .then((closed) => {
        const failures = closed.errors().map((failure) =>
          Object.assign(
            new Error(`${failure.source} cleanup failed: ${failure.error.message}`, {
              cause: failure.error,
            }),
            { code: failure.errorCode },
          ),
        )
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            `Slack socket cleanup failed: ${failures.map((failure) => failure.message).join("; ")}`,
            { cause: failures[0] },
          )
        session.running = null
      })
    session.closing = closing
    try {
      await closing
    } finally {
      if (session.closing === closing) session.closing = null
    }
  }

  private async openWithinDeadline(
    flume: Flume,
    session: SlackSession,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
  ): Promise<FlumeRunning> {
    const controller = session.controller
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`Slack event source start timed out after ${this.startTimeoutMs}ms`),
      )
    }, this.startTimeoutMs)
    const aborted = waitForAbort(controller.signal)
    const opened = flume.open()
    void opened.then(
      (running) => this.closeLateOpen(running, session, onLog),
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
    const previousWatchdogError = this.disarmWakeWatchdog()
    if (previousWatchdogError !== null) throw previousWatchdogError
    this.wakeLastCheckAt = this.wakeClock.now()
    try {
      this.wakeTimerCancel = this.wakeClock.setInterval(() => {
        this.checkForWake(controller, props)
      }, this.wakeCheckIntervalMs)
    } catch (error) {
      this.reportFailure(props.onLog, "wake.watchdog.schedule.failed", error)
      throw error
    }
  }

  private disarmWakeWatchdog(): Error | null {
    if (this.wakeTimerCancel === null) return null
    const cancel = this.wakeTimerCancel
    try {
      cancel()
      this.wakeTimerCancel = null
      return null
    } catch (error) {
      this.reportFailure(this.sourceLog, "wake.watchdog.cancel.failed", error)
      return normalizeError(error)
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
      this.publishStatus("disconnected", props.onStatus, props.onLog)
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
    this.publishStatus("reconnecting", props.onStatus, props.onLog)

    const previous = this.session
    if (previous !== null) {
      try {
        await this.closeSession(previous)
        if (this.session === previous) this.session = null
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
        throw error
      }
    }
    if (controller.signal.aborted || this.lifecycleController !== controller) return

    const next = this.createSession(controller)
    this.session = next
    try {
      const running = await this.openSession(next, props)
      if (controller.signal.aborted || this.lifecycleController !== controller) {
        next.running = running
        await this.closeSession(next)
        if (this.session === next) this.session = null
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
      try {
        await this.closeSession(next)
        if (this.session === next) this.session = null
      } catch (cleanup) {
        this.reportFailure(props.onLog, "wake.cleanup.failed", cleanup)
        throw new AggregateError(
          [error, cleanup],
          "Slack reconnect failed and cleanup was unconfirmed",
          { cause: error },
        )
      }
      throw error
    }
  }

  private closeLateOpen(
    running: FlumeRunning | Error,
    session: SlackSession,
    onLog: StartProps["onLog"],
  ): void {
    if (running instanceof Error || !session.controller.signal.aborted) return
    session.running = running
    void this.closeSession(session).catch((error) =>
      this.reportFailure(onLog, "open.late-close.failed", error),
    )
  }

  private handleEvent(
    event: FlumeEvent,
    onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
  ): void {
    if (event.source !== "slack") return
    try {
      void Promise.resolve(onEvent(toLeucoEnvelope(event))).catch((error) =>
        this.reportFailure(onLog, "event.handler.failed", error),
      )
    } catch (error) {
      this.reportFailure(onLog, "event.handler.failed", error)
    }
  }

  private handleLog(
    log: FlumeLog,
    onLog: ((log: LeucoSlackSourceLog) => void) | undefined,
    onStatus: ((status: LeucoSlackSourceStatus) => void) | undefined,
  ): void {
    const status = extractStatus(log)
    if (status !== null) {
      this.publishStatus(status, onStatus, onLog)
    }
    this.emitSourceLog(onLog, toLeucoLog(log))
  }

  private publishStatus(
    status: LeucoSlackSourceStatus,
    onStatus: StartProps["onStatus"],
    onLog: StartProps["onLog"],
  ): void {
    this.currentStatus = status
    try {
      void Promise.resolve(onStatus?.(status)).catch((error) =>
        this.reportFailure(onLog, "status.consumer.failed", error),
      )
    } catch (error) {
      this.reportFailure(onLog, "status.consumer.failed", error)
    }
  }

  private reportFailure(onLog: StartProps["onLog"], action: string, error: unknown): void {
    const normalized = normalizeError(error)
    this.emitSourceLog(onLog, {
      level: "error",
      action,
      message: normalized.message,
      error: normalized,
      detail: null,
      timestamp: this.wakeClock.now(),
    })
  }

  private writeDiagnostic(action: string, error: unknown): void {
    const message = [this.props.botToken, this.props.appToken]
      .filter(Boolean)
      .reduce((text, token) => text.split(token).join("[redacted]"), normalizeError(error).message)
    process.stderr.write(`[leuco slack ${action}] ${redactPublicText(message).slice(0, 4000)}\n`)
  }

  private emitSourceLog(onLog: StartProps["onLog"], log: LeucoSlackSourceLog): void {
    if (!onLog) {
      if (log.level === "error") this.writeDiagnostic(log.action, log.error ?? log.message)
      return
    }
    try {
      void Promise.resolve(onLog(log)).catch((error) => this.reportLogConsumerFailure(log, error))
    } catch (error) {
      this.reportLogConsumerFailure(log, error)
    }
  }

  private reportLogConsumerFailure(log: LeucoSlackSourceLog, error: unknown): void {
    this.writeDiagnostic(log.action, log.error ?? log.message)
    this.writeDiagnostic("log.consumer.failed", error)
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
