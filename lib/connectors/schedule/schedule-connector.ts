import {
  SCHEDULE_CONNECTOR_NAME,
  prepareScheduleInput,
} from "@/connectors/schedule/prepare-schedule-input"
import { formatScheduleLog } from "@/connectors/schedule/format-schedule-log"
import { randomUUID } from "node:crypto"
import { isCronDue } from "@/connectors/schedule/is-cron-due"
import { isCronSchedule } from "@/connectors/schedule/is-cron-schedule"
import { latestScheduleCatchup } from "@/connectors/schedule/latest-schedule-catchup"
import { parseScheduleCron } from "@/connectors/schedule/parse-schedule-cron"
import type { ScheduleStorePort } from "@/connectors/schedule/schedule-store-port"
import type { ScheduleEntry } from "@/config/config-schema"
import type { ConnectorIdentity, Connector, ConnectorContext } from "@/connectors/connector"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"

type Props = {
  /** Read/mutate access to this connector's entries. */
  store: ScheduleStorePort
  /** Tick cadence in milliseconds. Defaults to 60_000. */
  intervalMs?: number
  /**
   * Clock injection so tests can drive virtual time. Production leaves this
   * undefined and the connector uses the real `Date` constructor.
   */
  now?: () => Date
  /**
   * Hooks for the timer used by `start` / `stop`. Tests drive the connector
   * through `tickOnce()` directly, so they pass no-op replacements here to
   * suppress the real `setInterval`.
   */
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void
}

type OneShotRetry = {
  runAt: string
  failures: number
  retryAt: number
  lastFailure: { ts: number; message: string }
}

type OneShotRetryRequest = {
  entry: ScheduleEntry
  nowMs: number
  ctx: ConnectorContext
  error: unknown
}

type ScheduleTick = {
  ctx: ConnectorContext
  generation: number
  signal: AbortSignal
  entriesById: Map<string, ScheduleEntry> | null
  startedAt: number
}

const DEFAULT_INTERVAL_MS = 60_000
const ONE_SHOT_RETRY_BASE_MS = 60_000
const ONE_SHOT_RETRY_MAX_MS = 30 * 60_000
const ONE_SHOT_RETRY_MAX_FAILURES = 6

/**
 * Cap on how far back the connector will look when checking for missed cron
 * firings on daemon start / wake-from-sleep. A day of standups is useful;
 * resurrecting two-week-old cron triggers is noise.
 */
const CATCHUP_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

/**
 * Timer-driven connector. On each minute tick the connector re-reads its entry
 * list (so CLI mutations are picked up without a daemon restart) and,
 * for every enabled entry, decides whether to fire:
 *
 *   - cron expression (whitespace inside `runAt`): fire when the parsed
 *     fields match the current minute, plus a bounded persisted catch-up.
 *   - ISO 8601 timestamp: fire once when the parsed time has passed and
 *     remove the entry after a durable dispatch decision.
 *
 * The connector never posts directly to the user — like the Slack connector, it
 * forwards through `ctx.runTextTurn` and lets Codex decide whether to run
 * `leuco slack call` to surface a visible reply. Errors from
 * `runTextTurn` are caught so a single failing entry does not derail the
 * tick loop for the others. All execution decisions are persisted before dispatch:
 * after a crash it is safer to miss one occurrence than to replay a turn
 * whose external side effects may already have happened.
 */
export class LeucoScheduleConnector implements Connector {
  readonly name = SCHEDULE_CONNECTOR_NAME
  private readonly props: Props
  private readonly intervalMs: number
  private readonly now: () => Date
  private readonly setIntervalFn: NonNullable<Props["setIntervalFn"]>
  private readonly clearIntervalFn: NonNullable<Props["clearIntervalFn"]>
  private ctx: ConnectorContext | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly lastFiredMinute = new Map<string, number>()
  private readonly oneShotRetries = new Map<string, OneShotRetry>()
  /** Last scanned minute in this start/stop cycle, also used as the lower
   * bound for a never-fired entry. Failed durable writes do not consume an
   * occurrence. Restart clears this observation; durable marks still apply. */
  private readonly catchUpWalkedTo = new Map<string, { runAt: string; minute: number }>()
  private lastTickAt: number | null = null
  private lastFailure: { ts: number; message: string } | null = null
  private generation = 0
  private generationController: AbortController | null = null
  private tickInFlight: Promise<void> | null = null
  /** Promise for the startup catch-up tick. Tests await this to drive a
   * deterministic first run; production fires-and-forgets to avoid blocking
   * daemon ready on a slow first turn. */
  private startupTick: Promise<void> = Promise.resolve()

  constructor(props: Props) {
    this.props = props
    this.intervalMs = props.intervalMs ?? DEFAULT_INTERVAL_MS
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1 ||
      this.intervalMs > MAX_TIMER_DELAY_MS
    )
      throw new Error(
        `Schedule interval must be whole milliseconds between 1 and ${MAX_TIMER_DELAY_MS}`,
      )
    this.now = props.now ?? (() => new Date())
    this.setIntervalFn = props.setIntervalFn ?? setInterval
    this.clearIntervalFn = props.clearIntervalFn ?? clearInterval
  }

  async start(ctx: ConnectorContext): Promise<void> {
    if (this.ctx !== null || this.timer !== null || this.tickInFlight !== null)
      throw new Error(
        "Schedule connector is already started or stopping; await stop() before starting again",
      )
    this.generation += 1
    this.catchUpWalkedTo.clear()
    this.generationController?.abort()
    const generationController = new AbortController()
    this.generationController = generationController
    this.ctx = ctx
    this.log(ctx, `[${this.name}] schedule connector ready (tick=${this.intervalMs}ms)`)
    if (generationController.signal.aborted) throw new Error("Schedule start was cancelled")

    // Kick off the first tick (catch-up + any past one-shots) WITHOUT awaiting
    // it — a `runTextTurn` inside the first fire can take up to the runtime's
    // codex wall-clock timeout, and blocking `daemon ready` on that would
    // delay daemon readiness and other input connections for one overdue entry.
    this.startupTick = this.tickOnce()
    void this.startupTick
    if (generationController.signal.aborted) throw new Error("Schedule start was cancelled")

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

  getStatus() {
    const lastFailure =
      this.lastFailure ??
      [...this.oneShotRetries.values()]
        .map((retry) => retry.lastFailure)
        .sort((left, right) => right.ts - left.ts)[0] ??
      null
    const cleanup: { pending: number; nextRetryAt: number | null } = {
      pending: this.oneShotRetries.size,
      nextRetryAt: null,
    }
    for (const retry of this.oneShotRetries.values()) {
      if (cleanup.nextRetryAt === null || retry.retryAt < cleanup.nextRetryAt)
        cleanup.nextRetryAt = retry.retryAt
    }
    return {
      cleanup,
      state: this.ctx === null ? "stopped" : lastFailure === null ? "ready" : "error",
      lastActivityAt: this.lastTickAt,
      lastFailure: lastFailure === null ? null : { ...lastFailure },
    }
  }

  private recordFailure(
    error: unknown,
    ctx: ConnectorContext,
    diagnostic: { prefix?: string; requestId?: string } = {},
  ): void {
    this.lastFailure = {
      ts: this.now().getTime(),
      message: ctx.eventLog.redactError(error).message,
    }
    const prefix = diagnostic.prefix ?? `[${this.name}]`
    const line = formatScheduleLog(`${prefix} ${this.lastFailure.message}`, ctx.eventLog)
    ctx.eventLog.error(line, error, diagnostic.requestId)
    const mirror = ctx.onTextLog ?? ctx.onLog
    mirror(line, "error", diagnostic.requestId)
  }

  private log(ctx: ConnectorContext, line: string, requestId?: string): void {
    ctx.onLog(formatScheduleLog(line, ctx.eventLog), "info", requestId)
  }

  getIdentity(): ConnectorIdentity {
    return { name: this.name, type: "schedule", botUserId: null }
  }

  /**
   * Public for tests: drive the loop without spinning up a real interval.
   * Re-entrant calls are short-circuited so a slow `runTextTurn` (up to the
   * runtime's wall-clock timeout) inside the previous tick cannot interleave
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
      entriesById: null,
      startedAt: this.now().getTime(),
    }
    // Failure diagnostics may synchronously request another tick or stop.
    const execution = Promise.withResolvers<void>()
    const tickPromise = execution.promise
    this.tickInFlight = tickPromise
    execution.resolve(this.runTick(tick))
    try {
      await tickPromise
    } finally {
      if (this.tickInFlight === tickPromise) this.tickInFlight = null
    }
  }

  private async runTick(tick: ScheduleTick): Promise<void> {
    try {
      this.lastTickAt = tick.startedAt
      await this.tickOnceInner(tick)
    } catch (err) {
      // The interval fires this via `void this.tickOnce()`; anything that
      // escapes here becomes an unhandledRejection, and the daemon records those
      // as fatal asynchronous failures. Unreadable schedule settings during a
      // tick must not terminate the companion.
      if (!this.isTickCancelled(tick)) {
        this.recordFailure(err, tick.ctx, { prefix: `[${this.name}] tick failed:` })
      }
    }
  }

  private async tickOnceInner(tick: ScheduleTick): Promise<void> {
    let entries: ReturnType<typeof this.props.store.listEntries>
    try {
      entries = this.props.store.listEntries()
      this.lastFailure = null
    } catch (err) {
      this.recordFailure(err, tick.ctx, { prefix: `[${this.name}] failed to read entries:` })
      return
    }

    tick.entriesById = this.indexCurrentEntries(entries)
    const liveEntryIds = new Set(tick.entriesById.keys())
    for (const trackedId of this.lastFiredMinute.keys()) {
      if (!liveEntryIds.has(trackedId)) this.lastFiredMinute.delete(trackedId)
    }
    for (const trackedId of this.catchUpWalkedTo.keys()) {
      if (!liveEntryIds.has(trackedId)) this.catchUpWalkedTo.delete(trackedId)
    }

    for (const listedEntry of entries) {
      if (this.isTickCancelled(tick)) return
      if (tick.entriesById === null)
        tick.entriesById = this.indexCurrentEntries(this.props.store.listEntries())
      const entry = tick.entriesById.get(listedEntry.id)
      if (entry === undefined || !entry.enabled) continue
      const now = this.now()
      // A preceding turn may cross a minute boundary or a system-clock adjustment.
      const minuteEpoch = Math.floor(now.getTime() / 60_000)

      // 1. Catch-up firing for cron entries: when the daemon was down (or
      //    the machine was asleep) across a minute the cron expression
      //    would have matched, fire once on the next tick so daily / hourly
      //    schedules don't silently skip. Capped at 24h; one-shots already
      //    catch up implicitly via the `ts <= now` branch.
      const catchupFired = await this.maybeCatchUp(entry, minuteEpoch, tick)
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

  private indexCurrentEntries(entries: ReadonlyArray<ScheduleEntry>): Map<string, ScheduleEntry> {
    const indexed = new Map(entries.map((entry) => [entry.id, entry]))
    for (const trackedId of this.oneShotRetries.keys()) {
      const entry = indexed.get(trackedId)
      if (
        entry === undefined ||
        !entry.enabled ||
        entry.runAt !== this.oneShotRetries.get(trackedId)?.runAt
      )
        this.oneShotRetries.delete(trackedId)
    }
    return indexed
  }

  private async maybeCatchUp(
    entry: ScheduleEntry,
    minuteEpoch: number,
    tick: ScheduleTick,
  ): Promise<boolean> {
    if (!isCronSchedule(entry.runAt)) return false

    const observation = this.catchUpWalkedTo.get(entry.id)
    const walkedTo =
      observation !== undefined && observation.runAt === entry.runAt ? observation.minute : null
    const attempt = this.props.store.getLastAttempt(entry.id)
    // An old expression's decision cannot backfill a newly selected expression.
    const lastFiredAt =
      (attempt !== null && (attempt.runAt === null || attempt.runAt === entry.runAt)
        ? attempt.firedAt
        : null) ??
      walkedTo ??
      Math.floor(tick.startedAt / 60_000) * 60_000 - 1
    const currentMinuteStart = minuteEpoch * 60_000
    if (lastFiredAt >= currentMinuteStart) return false

    const parsed = parseScheduleCron(entry.runAt)
    if (parsed === null) return false

    const walkedThrough = currentMinuteStart - 60_000
    const latest = latestScheduleCatchup({
      cron: parsed,
      lastFiredAt: Math.max(lastFiredAt, walkedTo ?? 0),
      now: currentMinuteStart - 1,
      maxWindowMs: CATCHUP_MAX_LOOKBACK_MS,
    })
    if (latest === null) {
      this.catchUpWalkedTo.set(entry.id, { runAt: entry.runAt, minute: walkedThrough })
      return false
    }
    if (this.isTickCancelled(tick)) return false

    const delivered = await this.fire(entry, tick, "cron")
    const latestMinuteEpoch = Math.floor(latest / 60_000)
    const recorded = this.props.store.getLastAttempt(entry.id)
    if (
      recorded === null ||
      (recorded.runAt !== null && recorded.runAt !== entry.runAt) ||
      Math.floor(recorded.firedAt / 60_000) < latestMinuteEpoch
    )
      return false

    this.catchUpWalkedTo.set(entry.id, { runAt: entry.runAt, minute: walkedThrough })
    this.lastFiredMinute.set(entry.id, minuteEpoch)
    return delivered
  }

  private async fire(
    entry: ScheduleEntry,
    tick: ScheduleTick,
    kind: "cron" | "one-shot",
  ): Promise<boolean> {
    if (this.isTickCancelled(tick)) return false

    const input = (() => {
      try {
        return prepareScheduleInput(entry)
      } catch (error) {
        this.recordFailure(error, tick.ctx, {
          prefix: `[${this.name}] entry ${entry.name} not fired because input validation failed:`,
        })
        return null
      }
    })()
    if (input === null) return false

    {
      try {
        this.props.store.markFired(entry.id, this.now().getTime(), entry.runAt)
      } catch (err) {
        this.recordFailure(err, tick.ctx, {
          prefix: `[${this.name}] entry ${entry.name} not fired because durable mark failed:`,
        })
        return false
      }
    }

    const requestId = randomUUID()
    tick.ctx.eventLog.append({
      ts: Date.now(),
      requestId,
      type: "schedule.fired",
      entryId: entry.id,
      entryName: entry.name,
      runAt: entry.runAt,
      kind,
    })

    // Either diagnostic sink may stop this tick after the durable decision.
    if (this.isTickCancelled(tick)) return false
    this.log(tick.ctx, `[${this.name}] firing ${entry.name} (${kind})`, requestId)
    if (this.isTickCancelled(tick)) return false

    // Discard this tick's snapshot before waiting on Codex, including failed turns.
    tick.entriesById = null
    const reply = await tick.ctx.runTextTurn(input.threadKey, input.text, requestId)
    const turnFailed = reply instanceof Error
    if (turnFailed) {
      if (!this.isTickCancelled(tick)) {
        this.recordFailure(reply, tick.ctx, {
          prefix: `[${this.name}] entry ${entry.name} turn failed:`,
          requestId,
        })
      }
      return false
    }

    return true
  }

  private async fireOneShot(entry: ScheduleEntry, now: Date, tick: ScheduleTick): Promise<void> {
    const nowMs = now.getTime()
    if (this.isWaitingForOneShotRetry(entry, nowMs)) return
    const attempt = this.props.store.getLastAttempt(entry.id)
    const attempted =
      attempt !== null &&
      (attempt.runAt === null
        ? attempt.firedAt >= Date.parse(entry.runAt)
        : !isCronSchedule(attempt.runAt) && Date.parse(attempt.runAt) === Date.parse(entry.runAt))
    if (attempted)
      this.log(
        tick.ctx,
        `[${this.name}] entry ${entry.name} already attempted; retrying cleanup only`,
      )
    else if (!(await this.fire(entry, tick, "one-shot"))) return
    this.removeAttemptedOneShot(entry, tick.ctx)
  }

  private wasCronFiredAtOrAfter(entry: ScheduleEntry, minuteEpoch: number): boolean {
    if (!isCronSchedule(entry.runAt)) return false
    const lastFiredAt = this.props.store.getLastAttempt(entry.id)?.firedAt ?? null
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
    return false
  }

  private removeAttemptedOneShot(entry: ScheduleEntry, ctx: ConnectorContext): void {
    try {
      const removed = this.props.store.removeEntry(entry.id, entry.runAt)
      this.oneShotRetries.delete(entry.id)
      this.log(
        ctx,
        removed
          ? `[${this.name}] entry ${entry.name} removed after recorded attempt; no replay`
          : `[${this.name}] entry ${entry.name} cleanup skipped: schedule changed or already absent`,
      )
    } catch (err) {
      this.recordFailure(err, ctx)
      this.postponeOneShot({
        entry,
        nowMs: this.now().getTime(),
        ctx,
        error: err,
      })
    }
  }

  private postponeOneShot(request: OneShotRetryRequest): void {
    const previous = this.oneShotRetries.get(request.entry.id)
    const previousFailures = previous?.runAt === request.entry.runAt ? previous.failures : 0
    const failures = Math.min(previousFailures + 1, ONE_SHOT_RETRY_MAX_FAILURES)
    const delayMs = oneShotRetryDelayMs(failures)
    const message = request.ctx.eventLog.redactError(request.error).message
    this.oneShotRetries.set(request.entry.id, {
      runAt: request.entry.runAt,
      failures,
      retryAt: request.nowMs + delayMs,
      lastFailure: { ts: request.nowMs, message },
    })
    this.log(
      request.ctx,
      `[${this.name}] entry ${request.entry.name} cleanup retry #${failures} in ${delayMs / 1000}s: delete failed: ${message}`,
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
  ctx: ConnectorContext,
): "cron" | "one-shot" | "skip" => {
  if (isCronSchedule(entry.runAt)) {
    const parsed = parseScheduleCron(entry.runAt)
    if (parsed === null) {
      ctx.onLog(
        formatScheduleLog(
          `[schedule] entry ${entry.name} has bad cron '${entry.runAt}'`,
          ctx.eventLog,
        ),
      )
      return "skip"
    }
    return isCronDue(parsed, now) ? "cron" : "skip"
  }

  const timestamp = Date.parse(entry.runAt)
  if (Number.isNaN(timestamp)) {
    ctx.onLog(
      formatScheduleLog(
        `[schedule] entry ${entry.name} has unparseable runAt: '${entry.runAt}'`,
        ctx.eventLog,
      ),
    )
    return "skip"
  }
  return timestamp <= now.getTime() ? "one-shot" : "skip"
}
