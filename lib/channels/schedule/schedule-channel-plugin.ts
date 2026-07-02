import {
  cronMatches,
  looksLikeCron,
  parseCronExpression,
} from "@/channels/schedule/cron-expression"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import type { ScheduleEntry } from "@/config/config-schema"
import type { ChannelIdentity, ChannelPlugin, ChannelPluginContext } from "@/engine/channel-plugin"
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

const DEFAULT_INTERVAL_MS = 60_000

/**
 * Cap on how far back the plugin will look when checking for missed cron
 * firings on daemon start / wake-from-sleep. A day of standups is useful;
 * resurrecting two-week-old cron triggers is noise.
 */
const CATCHUP_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000

/**
 * Timer-driven channel. On each pass the plugin re-reads its entry list (so
 * CLI/MCP mutations are picked up without a daemon restart) and, for every
 * enabled entry, decides whether to fire:
 *
 *   - cron expression (whitespace inside `runAt`): evaluated against every
 *     wall-clock minute since the previous completed pass — not just the
 *     current one — so minutes skipped by a slow turn holding the tick,
 *     interval drift, or sleep still fire. Entries with a persisted
 *     `lastFiredAt` additionally catch up across daemon restarts. Both
 *     windows share the 24h lookback cap and fire at most one turn per
 *     entry per pass.
 *   - ISO 8601 timestamp: fire once when the parsed time has passed and
 *     remove the entry from settings.json regardless of turn outcome.
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
  private inflightTick: Promise<void> | null = null
  private stopped = false
  /** Minute epoch the last completed pass evaluated up to (inclusive). Null
   * until the first pass finishes. Each pass covers the cron minutes in
   * `(lastEvaluatedMinuteEpoch, currentMinute]`, so minutes the interval
   * skipped are still evaluated instead of silently lost. */
  private lastEvaluatedMinuteEpoch: number | null = null
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
    this.stopped = false
    this.ctx = ctx
    ctx.onLog(`[${this.name}] schedule channel ready (tick=${this.intervalMs}ms)`)

    // Kick off the first tick (catch-up + any past one-shots) WITHOUT awaiting
    // it — a `runTextTurn` inside the first fire can take up to the 10-minute
    // codex timeout, and blocking `daemon ready` on that would delay the
    // gateway, MCP endpoint, and every other plugin start for a single
    // overdue schedule entry.
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
    this.stopped = true

    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }

    // A tick can be mid-`runTextTurn` when stop is called. Awaiting it here
    // keeps a zombie tick from dispatching turns and writing to the store
    // after reconcile has already started a replacement plugin.
    const inflight = this.inflightTick
    if (inflight !== null) await inflight

    this.ctx = null
  }

  getIdentity(): ChannelIdentity {
    return { name: this.name, type: "schedule", botUserId: null }
  }

  /**
   * Public for tests: drive the loop without spinning up a real interval.
   * Re-entrant calls are short-circuited via `inflightTick` so a slow
   * `runTextTurn` (up to 10 minutes) inside the previous tick cannot
   * interleave with the next interval and double-fire the same entry.
   */
  async tickOnce(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    if (this.stopped) return
    if (this.inflightTick !== null) return

    this.inflightTick = this.tickOnceInner(ctx).finally(() => {
      this.inflightTick = null
    })

    await this.inflightTick
  }

  private async tickOnceInner(ctx: ChannelPluginContext): Promise<void> {
    let entries: ReturnType<typeof this.props.store.listEntries>
    try {
      entries = this.props.store.listEntries()
    } catch (err) {
      ctx.onLog(`[${this.name}] failed to read entries: ${errorMessage(err)}`)
      return
    }

    const liveEntryIds = new Set(entries.map((entry) => entry.id))
    for (const trackedId of this.lastFiredMinute.keys()) {
      if (!liveEntryIds.has(trackedId)) this.lastFiredMinute.delete(trackedId)
    }

    const now = this.now()
    // Dedup window is always one wall-clock minute (cron resolution). Don't
    // tie this to `intervalMs` even if the tick rate is overridden in tests.
    const minuteEpoch = Math.floor(now.getTime() / 60_000)

    for (const entry of entries) {
      if (this.stopped) return
      if (!entry.enabled) continue
      if (this.lastFiredMinute.get(entry.id) === minuteEpoch) continue

      if (looksLikeCron(entry.runAt)) {
        await this.evaluateCron(entry, now, ctx)
        continue
      }

      await this.evaluateOneShot(entry, now, ctx)
    }

    this.lastEvaluatedMinuteEpoch = minuteEpoch
  }

  /**
   * Walk the entry's unevaluated minutes newest-first and fire on the first
   * match. At most one turn per entry per pass regardless of how many
   * minutes in the window matched — the prompt is identical anyway, and one
   * event per skipped minute would flood the bus when the gap is long.
   */
  private async evaluateCron(
    entry: ScheduleEntry,
    now: Date,
    ctx: ChannelPluginContext,
  ): Promise<void> {
    let expr: ReturnType<typeof parseCronExpression>
    try {
      expr = parseCronExpression(entry.runAt)
    } catch (err) {
      ctx.onLog(
        `[${this.name}] entry ${entry.name} has bad cron '${entry.runAt}': ${errorMessage(err)}`,
      )
      return
    }

    const minuteEpoch = Math.floor(now.getTime() / 60_000)
    const windowStartMs = this.cronWindowStartMs(entry, now)

    let cursor = minuteEpoch * 60_000
    while (cursor > windowStartMs) {
      if (cronMatches(expr, new Date(cursor))) {
        if (this.stopped) return
        this.lastFiredMinute.set(entry.id, minuteEpoch)
        await this.fire(entry, ctx, "cron")
        return
      }
      cursor -= 60_000
    }
  }

  /**
   * Exclusive lower bound (epoch ms) of the minutes `evaluateCron` still owes
   * this entry. Union of the in-memory window (minutes after the last
   * completed pass) and the persisted `lastFiredAt` (across-restart catch-up),
   * capped at the 24h lookback. `lastFiredAt` is written at fire-decision
   * time, so a minute that already fired sits at or below the bound and the
   * strict `>` walk in `evaluateCron` cannot re-fire it. An entry with
   * neither bound (never fired, first pass) gets the current minute only.
   */
  private cronWindowStartMs(entry: ScheduleEntry, now: Date): number {
    const currentMinuteStartMs = Math.floor(now.getTime() / 60_000) * 60_000
    const lastFiredAt = this.props.store.getLastFiredAt(entry.id)

    const boundsMs: number[] = []
    if (this.lastEvaluatedMinuteEpoch !== null) {
      boundsMs.push(this.lastEvaluatedMinuteEpoch * 60_000)
    }
    if (lastFiredAt !== null) boundsMs.push(lastFiredAt)

    if (boundsMs.length === 0) return currentMinuteStartMs - 60_000

    return Math.max(Math.min(...boundsMs), now.getTime() - CATCHUP_MAX_LOOKBACK_MS)
  }

  private async evaluateOneShot(
    entry: ScheduleEntry,
    now: Date,
    ctx: ChannelPluginContext,
  ): Promise<void> {
    const ts = Date.parse(entry.runAt)
    if (Number.isNaN(ts)) {
      ctx.onLog(`[${this.name}] entry ${entry.name} has unparseable runAt: '${entry.runAt}'`)
      return
    }

    if (ts > now.getTime()) return
    if (this.stopped) return

    this.lastFiredMinute.set(entry.id, Math.floor(now.getTime() / 60_000))
    await this.fire(entry, ctx, "one-shot")
  }

  private async fire(
    entry: ScheduleEntry,
    ctx: ChannelPluginContext,
    kind: "cron" | "one-shot",
  ): Promise<void> {
    ctx.bus.emit({
      ts: Date.now(),
      type: "schedule.fired",
      project: ctx.projectName,
      channel: this.name,
      entryId: entry.id,
      entryName: entry.name,
      runAt: entry.runAt,
      kind,
    })

    if (kind === "cron") {
      // Persist at fire-decision time, not after the turn. Advancing only on
      // success left `lastFiredAt` stale when the turn failed, so every
      // subsequent tick re-discovered the same missed minute and re-fired for
      // up to the 24h cap — a retry storm. The failure itself stays visible
      // through the turn error log and turn.* events.
      try {
        this.props.store.markFired(entry.id, this.now().getTime())
      } catch (err) {
        ctx.onLog(`[${this.name}] entry ${entry.name} failed to mark fired: ${errorMessage(err)}`)
      }
    }

    const threadKey = `schedule:${entry.id}`
    const text = formatPrompt(this.name, entry)
    ctx.onLog(`[${this.name}] firing ${entry.name} (${kind})`)

    const reply = await ctx.runTextTurn(threadKey, text)
    if (reply instanceof Error) {
      ctx.onLog(`[${this.name}] entry ${entry.name} turn failed: ${reply.message}`)
    }

    if (kind === "one-shot") {
      // Always delete one-shots — keeping them on error would re-fire every
      // tick forever (their `ts <= now` matches indefinitely).
      try {
        this.props.store.removeEntry(entry.id)
      } catch (err) {
        ctx.onLog(
          `[${this.name}] entry ${entry.name} fired but failed to delete: ${errorMessage(err)}`,
        )
      }
    }
  }
}

const formatPrompt = (channelName: string, entry: ScheduleEntry): string => {
  return [
    `<schedule channel="${channelName}" entry="${entry.name}" run-at="${entry.runAt}">`,
    entry.prompt,
    `</schedule>`,
  ].join("\n")
}
