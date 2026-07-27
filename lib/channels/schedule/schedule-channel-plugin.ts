import {
  cronMatches,
  looksLikeCron,
  parseCronExpression,
} from "@/channels/schedule/cron-expression"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import type { ScheduleEntry } from "@/config/config-schema"
import type {
  ChannelIdentity,
  ChannelPlugin,
  ChannelPluginContext,
} from "@/channels/channel-plugin"
import { errorMessage } from "@/error-message"

type Props = {
  /** Channel name as configured in settings.json. */
  name: string
  /** Read/mutate access to this channel's entries. */
  store: ScheduleStorePort
  /** Tick cadence in milliseconds. Defaults to 60_000. */
  intervalMs?: number
  /**
   * Clock injection so tests can drive virtual time. Production leaves this
   * undefined and the plugin uses the real `Date` constructor.
   */
  now?: () => Date
  /**
   * Hooks for the timer used by `start` / `stop`. Tests drive the plugin
   * through `tickOnce()` directly, so they pass no-op replacements here to
   * suppress the real `setInterval`.
   */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
}

type OneShotRetryStage = "turn" | "cleanup"

type OneShotRetry = {
  runAt: string
  stage: OneShotRetryStage
  failures: number
  retryAt: number
}

type OneShotRetryRequest = {
  entry: ScheduleEntry
  nowMs: number
  stage: OneShotRetryStage
  ctx: ChannelPluginContext
  reason: string
}

type ScheduleTick = {
  ctx: ChannelPluginContext
  generation: number
  signal: AbortSignal
}

const DEFAULT_INTERVAL_MS = 60_000
const ONE_SHOT_RETRY_BASE_MS = 60_000
const ONE_SHOT_RETRY_MAX_MS = 30 * 60_000
const ONE_SHOT_RETRY_MAX_FAILURES = 6

/**
 * Cap on how far back the plugin will look when checking for missed cron
 * firings on daemon start / wake-from-sleep. A day of standups is useful;
 * resurrecting two-week-old cron triggers is noise.
 */
const CATCHUP_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

/**
 * Timer-driven channel. On each minute tick the plugin re-reads its entry
 * list (so CLI/MCP mutations are picked up without a daemon restart) and,
 * for every enabled entry, decides whether to fire:
 *
 *   - cron expression (whitespace inside `runAt`): fire when the parsed
 *     fields match the current minute, plus a bounded persisted catch-up.
 *   - ISO 8601 timestamp: fire once when the parsed time has passed and
 *     remove the entry only after successful delivery.
 *
 * The plugin never posts directly to the user — like the Slack channel, it
 * forwards through `ctx.runTextTurn` and lets codex decide whether to call
 * `slack_call` (or anything else) to surface a visible reply. Errors from
 * `runTextTurn` are caught so a single failing entry does not derail the
 * tick loop for the others.
 */
export class LeucoScheduleChannelPlugin implements ChannelPlugin {
  readonly name: string
  private readonly props: Props
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly setIntervalFn: NonNullable<Props["setIntervalFn"]>
  private readonly clearIntervalFn: NonNullable<Props["clearIntervalFn"]>
  private ctx: ChannelPluginContext | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly lastFiredMinute = new Map<string, number>()
  private readonly oneShotRetries = new Map<string, OneShotRetry>()
  /** In-process guard for the narrow case where the turn succeeded but both
   * the durable marker and settings deletion failed. */
  private readonly deliveredOneShotRunAt = new Map<string, string>()
  /** How far (epoch ms, minute-aligned) the catch-up walk has scanned per
   * entry in THIS process. Persisted `lastFiredAt` only advances on a
   * successful turn, so without this in-memory floor a persistently failing
   * cron would be re-fired by the catch-up branch on every tick until the
   * 24h lookback expires. With it, a failed fire is retried once via
   * catch-up and then left for the next daemon start. */
  private readonly catchUpWalkedTo = new Map<string, number>()
  private generation = 0
  private generationController: AbortController | null = null
  private tickInFlight: Promise<void> | null = null
  /** Promise for the startup catch-up tick. Tests await this to drive a
   * deterministic first run; production fires-and-forgets to avoid blocking
   * daemon ready on a slow first turn. */
  private startupTick: Promise<void> = Promise.resolve()

  constructor(props: Props) {
    this.name = props.name
    this.props = props
    this.intervalMs = props.intervalMs ?? DEFAULT_INTERVAL_MS
    this.now = props.now ?? (() => new Date())
    this.setIntervalFn = props.setIntervalFn ?? setInterval
    this.clearIntervalFn = props.clearIntervalFn ?? clearInterval
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.generation += 1
    this.generationController?.abort()
    const generationController = new AbortController()
    this.generationController = generationController
    this.ctx = ctx
    ctx.onLog(`[${this.name}] schedule channel ready (tick=${this.intervalMs}ms)`)

    // Kick off the first tick (catch-up + any past one-shots) WITHOUT awaiting
    // it — a `runTextTurn` inside the first fire can take up to the tenant's
    // codex wall-clock timeout, and blocking `daemon ready` on that would
    // delay the gateway, MCP endpoint, and every other plugin start for a
    // single overdue schedule entry.
    this.startupTick = this.tickOnce()
    void this.startupTick

    this.timer = this.setIntervalFn(() => {
      void this.tickOnce()
    }, this.intervalMs)
  }

  /** Test-only: await the start-time catch-up tick. Production code should
   * never need this; the daemon expects `start()` to return promptly. */
  async waitForStartupTick(): Promise<void> {
    await this.startupTick
  }

  async stop(): Promise<void> {
    this.generation += 1
    this.generationController?.abort()
    this.generationController = null
    this.ctx = null

    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }

    const tickInFlight = this.tickInFlight
    if (tickInFlight !== null) await tickInFlight
  }

  getIdentity(): ChannelIdentity {
    return { name: this.name, type: "schedule", botUserId: null }
  }

  /**
   * Public for tests: drive the loop without spinning up a real interval.
   * Re-entrant calls are short-circuited so a slow `runTextTurn` (up to the
   * tenant's wall-clock timeout) inside the previous tick cannot interleave
   * with the next interval and double-fire the same entry via the catch-up
   * branch.
   */
  async tickOnce(): Promise<void> {
    const ctx = this.ctx
    const generationController = this.generationController
    if (!ctx || !generationController || generationController.signal.aborted) return
    if (this.tickInFlight !== null) return

    const tick: ScheduleTick = {
      ctx,
      generation: this.generation,
      signal: generationController.signal,
    }
    const tickPromise = this.runTick(tick)
    this.tickInFlight = tickPromise
    try {
      await tickPromise
    } finally {
      if (this.tickInFlight === tickPromise) this.tickInFlight = null
    }
  }

  private async runTick(tick: ScheduleTick): Promise<void> {
    try {
      await this.tickOnceInner(tick)
    } catch (err) {
      // The interval fires this via `void this.tickOnce()`; anything that
      // escapes here becomes an unhandledRejection, and run.ts answers those
      // with a full daemon shutdown. One broken store read (e.g. the project
      // was removed mid-tick) must not take every tenant down.
      if (!this.isTickCancelled(tick)) {
        tick.ctx.onLog(`[${this.name}] tick failed: ${errorMessage(err)}`)
      }
    }
  }

  private async tickOnceInner(tick: ScheduleTick): Promise<void> {
    let entries: ReturnType<typeof this.props.store.listEntries>
    try {
      entries = this.props.store.listEntries()
    } catch (err) {
      tick.ctx.onLog(`[${this.name}] failed to read entries: ${errorMessage(err)}`)
      return
    }

    const liveEntryIds = new Set(entries.map((entry) => entry.id))
    for (const trackedId of this.lastFiredMinute.keys()) {
      if (!liveEntryIds.has(trackedId)) this.lastFiredMinute.delete(trackedId)
    }
    for (const trackedId of this.catchUpWalkedTo.keys()) {
      if (!liveEntryIds.has(trackedId)) this.catchUpWalkedTo.delete(trackedId)
    }
    for (const trackedId of this.oneShotRetries.keys()) {
      if (!liveEntryIds.has(trackedId)) this.oneShotRetries.delete(trackedId)
    }
    for (const trackedId of this.deliveredOneShotRunAt.keys()) {
      if (!liveEntryIds.has(trackedId)) this.deliveredOneShotRunAt.delete(trackedId)
    }

    const now = this.now()
    // Dedup window is always one wall-clock minute (cron resolution). Don't
    // tie this to `intervalMs` even if the tick rate is overridden in tests.
    const minuteEpoch = Math.floor(now.getTime() / 60_000)

    for (const entry of entries) {
      if (this.isTickCancelled(tick)) return
      if (!entry.enabled) continue

      // 1. Catch-up firing for cron entries: when the daemon was down (or
      //    the machine was asleep) across a minute the cron expression
      //    would have matched, fire once on the next tick so daily / hourly
      //    schedules don't silently skip. Capped at 24h; one-shots already
      //    catch up implicitly via the `ts <= now` branch.
      const catchupFired = await this.maybeCatchUp(entry, now, minuteEpoch, tick)
      if (this.isTickCancelled(tick)) return

      if (this.lastFiredMinute.get(entry.id) === minuteEpoch) continue
      if (this.wasCronFiredAtOrAfter(entry, minuteEpoch)) {
        this.lastFiredMinute.set(entry.id, minuteEpoch)
        continue
      }

      const decision = decideFire(entry, now, tick.ctx)
      if (decision === "skip") {
        if (catchupFired) this.lastFiredMinute.set(entry.id, minuteEpoch)
        continue
      }

      this.lastFiredMinute.set(entry.id, minuteEpoch)
      if (decision === "one-shot") {
        await this.fireOneShot(entry, now, tick)
        continue
      }
      await this.fire(entry, tick, decision)
    }
  }

  private async maybeCatchUp(
    entry: ScheduleEntry,
    now: Date,
    minuteEpoch: number,
    tick: ScheduleTick,
  ): Promise<boolean> {
    if (!looksLikeCron(entry.runAt)) return false

    const lastFiredAt = this.props.store.getLastFiredAt(entry.id)
    if (lastFiredAt === null) return false

    const parsed = tryParseCronExpression(entry.runAt)
    if (parsed === null) return false

    const walkedTo = this.catchUpWalkedTo.get(entry.id) ?? 0
    const cutoff = Math.max(lastFiredAt, now.getTime() - CATCHUP_MAX_LOOKBACK_MS, walkedTo)
    const currentMinuteStart = minuteEpoch * 60_000
    this.catchUpWalkedTo.set(entry.id, currentMinuteStart - 60_000)

    const cursor = { value: currentMinuteStart - 60_000 }
    while (cursor.value > cutoff) {
      if (cronMatches(parsed, new Date(cursor.value))) {
        if (this.isTickCancelled(tick)) return false
        this.lastFiredMinute.set(entry.id, minuteEpoch)
        await this.fire(entry, tick, "cron")
        return true
      }
      cursor.value -= 60_000
    }
    return false
  }

  private async fire(
    entry: ScheduleEntry,
    tick: ScheduleTick,
    kind: "cron" | "one-shot",
  ): Promise<boolean> {
    if (this.isTickCancelled(tick)) return false

    tick.ctx.bus.emit({
      ts: Date.now(),
      type: "schedule.fired",
      project: tick.ctx.projectName,
      channel: this.name,
      entryId: entry.id,
      entryName: entry.name,
      runAt: entry.runAt,
      kind,
    })

    const threadKey = `schedule:${entry.id}`
    const text = formatPrompt(this.name, entry)
    tick.ctx.onLog(`[${this.name}] firing ${entry.name} (${kind})`)

    const reply = await tick.ctx.runTextTurn(threadKey, text)
    const turnFailed = reply instanceof Error
    if (turnFailed) {
      if (!this.isTickCancelled(tick)) {
        tick.ctx.onLog(`[${this.name}] entry ${entry.name} turn failed: ${reply.message}`)
      }
      return false
    }

    if (kind === "cron") {
      try {
        this.props.store.markFired(entry.id, this.now().getTime())
      } catch (err) {
        tick.ctx.onLog(
          `[${this.name}] entry ${entry.name} fired but failed to mark: ${errorMessage(err)}`,
        )
      }
    }

    return true
  }

  private async fireOneShot(entry: ScheduleEntry, now: Date, tick: ScheduleTick): Promise<void> {
    const nowMs = now.getTime()
    if (this.isWaitingForOneShotRetry(entry, nowMs)) return

    const durableMarker = this.props.store.getLastFiredAt(entry.id)
    const isDurable = durableMarker !== null && durableMarker >= Date.parse(entry.runAt)
    const isDelivered = this.deliveredOneShotRunAt.get(entry.id) === entry.runAt

    if (!isDurable && !isDelivered) {
      const delivered = await this.deliverOneShot(entry, nowMs, tick)
      if (!delivered) return
    } else if (isDurable && !isDelivered) {
      tick.ctx.onLog(`[${this.name}] entry ${entry.name} already delivered; retrying cleanup only`)
    }

    if (!isDurable) this.markOneShotDelivered(entry, nowMs, tick.ctx)
    this.removeDeliveredOneShot(entry, nowMs, tick.ctx)
  }

  private async deliverOneShot(
    entry: ScheduleEntry,
    nowMs: number,
    tick: ScheduleTick,
  ): Promise<boolean> {
    const succeeded = await this.fire(entry, tick, "one-shot")
    if (!succeeded) {
      if (!this.isTickCancelled(tick)) {
        this.postponeOneShot({
          entry,
          nowMs,
          stage: "turn",
          ctx: tick.ctx,
          reason: "turn failed",
        })
      }
      return false
    }
    this.deliveredOneShotRunAt.set(entry.id, entry.runAt)
    this.oneShotRetries.delete(entry.id)
    return true
  }

  private wasCronFiredAtOrAfter(entry: ScheduleEntry, minuteEpoch: number): boolean {
    if (!looksLikeCron(entry.runAt)) return false
    const lastFiredAt = this.props.store.getLastFiredAt(entry.id)
    if (lastFiredAt === null) return false
    return Math.floor(lastFiredAt / 60_000) >= minuteEpoch
  }

  private isTickCancelled(tick: ScheduleTick): boolean {
    return tick.signal.aborted || tick.generation !== this.generation
  }

  private isWaitingForOneShotRetry(entry: ScheduleEntry, nowMs: number): boolean {
    const retry = this.oneShotRetries.get(entry.id)
    if (retry === undefined) return false
    if (retry.runAt === entry.runAt) return retry.retryAt > nowMs

    this.oneShotRetries.delete(entry.id)
    this.deliveredOneShotRunAt.delete(entry.id)
    return false
  }

  private markOneShotDelivered(
    entry: ScheduleEntry,
    nowMs: number,
    ctx: ChannelPluginContext,
  ): void {
    try {
      this.props.store.markFired(entry.id, nowMs)
    } catch (err) {
      ctx.onLog(
        `[${this.name}] entry ${entry.name} delivered but durable mark failed: ${errorMessage(err)}`,
      )
    }
  }

  private removeDeliveredOneShot(
    entry: ScheduleEntry,
    nowMs: number,
    ctx: ChannelPluginContext,
  ): void {
    try {
      this.props.store.removeEntry(entry.id)
      this.oneShotRetries.delete(entry.id)
      this.deliveredOneShotRunAt.delete(entry.id)
      ctx.onLog(`[${this.name}] entry ${entry.name} delivered and removed`)
    } catch (err) {
      this.postponeOneShot({
        entry,
        nowMs,
        stage: "cleanup",
        ctx,
        reason: `delete failed: ${errorMessage(err)}`,
      })
    }
  }

  private postponeOneShot(request: OneShotRetryRequest): void {
    const previous = this.oneShotRetries.get(request.entry.id)
    const previousFailures =
      previous?.runAt === request.entry.runAt && previous.stage === request.stage
        ? previous.failures
        : 0
    const failures = Math.min(previousFailures + 1, ONE_SHOT_RETRY_MAX_FAILURES)
    const delayMs = oneShotRetryDelayMs(failures)
    this.oneShotRetries.set(request.entry.id, {
      runAt: request.entry.runAt,
      stage: request.stage,
      failures,
      retryAt: request.nowMs + delayMs,
    })
    request.ctx.onLog(
      `[${this.name}] entry ${request.entry.name} ${request.stage} retry #${failures} in ${delayMs / 1000}s: ${request.reason}`,
    )
  }
}

const oneShotRetryDelayMs = (failures: number): number => {
  const exponent = Math.max(0, failures - 1)
  return Math.min(ONE_SHOT_RETRY_BASE_MS * 2 ** exponent, ONE_SHOT_RETRY_MAX_MS)
}

const decideFire = (
  entry: ScheduleEntry,
  now: Date,
  ctx: ChannelPluginContext,
): "cron" | "one-shot" | "skip" => {
  if (looksLikeCron(entry.runAt)) {
    const parsed = tryParseCronExpression(entry.runAt)
    if (parsed === null) {
      ctx.onLog(`[schedule] entry ${entry.name} has bad cron '${entry.runAt}'`)
      return "skip"
    }
    return cronMatches(parsed, now) ? "cron" : "skip"
  }

  const timestamp = Date.parse(entry.runAt)
  if (Number.isNaN(timestamp)) {
    ctx.onLog(`[schedule] entry ${entry.name} has unparseable runAt: '${entry.runAt}'`)
    return "skip"
  }
  return timestamp <= now.getTime() ? "one-shot" : "skip"
}

const tryParseCronExpression = (runAt: string): ReturnType<typeof parseCronExpression> | null => {
  try {
    return parseCronExpression(runAt)
  } catch {
    return null
  }
}

const formatPrompt = (channelName: string, entry: ScheduleEntry): string => {
  return [
    `<schedule channel="${channelName}" entry="${entry.name}" run-at="${entry.runAt}">`,
    entry.prompt,
    `</schedule>`,
  ].join("\n")
}
