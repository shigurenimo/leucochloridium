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
 * Timer-driven channel. On each minute tick the plugin re-reads its entry
 * list (so CLI/MCP mutations are picked up without a daemon restart) and,
 * for every enabled entry, decides whether to fire:
 *
 *   - cron expression (whitespace inside `runAt`): fire when the parsed
 *     fields match the current minute; resilient to multiple ticks within
 *     the same minute via the in-memory `lastFiredMinute` map.
 *   - ISO 8601 timestamp: fire once when the parsed time has passed and
 *     remove the entry from settings.json after a successful turn dispatch.
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
  private tickInFlight = false

  constructor(props: Props) {
    this.name = props.name
    this.props = props
    this.intervalMs = props.intervalMs ?? DEFAULT_INTERVAL_MS
    this.now = props.now ?? (() => new Date())
    this.setIntervalFn = props.setIntervalFn ?? setInterval
    this.clearIntervalFn = props.clearIntervalFn ?? clearInterval
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx
    ctx.onLog(`[${this.name}] schedule channel ready (tick=${this.intervalMs}ms)`)

    // Fire once immediately so any past one-shots dispatch on daemon startup
    // instead of waiting up to a full interval.
    await this.tickOnce()

    this.timer = this.setIntervalFn(() => {
      void this.tickOnce()
    }, this.intervalMs)
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer)
      this.timer = null
    }
    this.ctx = null
  }

  getIdentity(): ChannelIdentity {
    return { name: this.name, type: "schedule", botUserId: null }
  }

  /**
   * Public for tests: drive the loop without spinning up a real interval.
   * Re-entrant calls are short-circuited so a slow `runTextTurn` (up to 10
   * minutes) inside the previous tick cannot interleave with the next
   * interval and double-fire the same entry via the catch-up branch.
   */
  async tickOnce(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    if (this.tickInFlight) return

    this.tickInFlight = true
    try {
      await this.tickOnceInner(ctx)
    } finally {
      this.tickInFlight = false
    }
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
      if (!entry.enabled) continue

      // 1. Catch-up firing for cron entries: when the daemon was down (or
      //    the machine was asleep) across a minute the cron expression
      //    would have matched, fire once on the next tick so daily / hourly
      //    schedules don't silently skip. Capped at 24h; one-shots already
      //    catch up implicitly via the `ts <= now` branch.
      const catchupFired = await this.maybeCatchUp(entry, now, minuteEpoch, ctx)

      if (this.lastFiredMinute.get(entry.id) === minuteEpoch) continue

      const decision = decideFire(entry, now, ctx)
      if (decision === "skip") {
        if (catchupFired) this.lastFiredMinute.set(entry.id, minuteEpoch)
        continue
      }

      this.lastFiredMinute.set(entry.id, minuteEpoch)
      await this.fire(entry, ctx, decision)
    }
  }

  private async maybeCatchUp(
    entry: ScheduleEntry,
    now: Date,
    minuteEpoch: number,
    ctx: ChannelPluginContext,
  ): Promise<boolean> {
    if (!looksLikeCron(entry.runAt)) return false

    const lastFiredAt = this.props.store.getLastFiredAt(entry.id)
    if (lastFiredAt === null) return false

    // Parse once outside the minute loop — the cron string is invariant across
    // the catch-up window so re-parsing per minute is pure overhead (up to
    // 1440 invocations at the 24h cap).
    let expr: ReturnType<typeof parseCronExpression>
    try {
      expr = parseCronExpression(entry.runAt)
    } catch {
      return false
    }

    const cutoff = Math.max(lastFiredAt, now.getTime() - CATCHUP_MAX_LOOKBACK_MS)
    const currentMinuteStart = minuteEpoch * 60_000

    // Walk minutes between (cutoff, current minute] looking for a single
    // missed match. One catch-up fire per gap is enough — the prompt is
    // identical anyway, and emitting one event per skipped minute would
    // flood the bus when the gap is long.
    let cursor = currentMinuteStart - 60_000
    while (cursor > cutoff) {
      if (cronMatches(expr, new Date(cursor))) {
        this.lastFiredMinute.set(entry.id, minuteEpoch)
        await this.fire(entry, ctx, "cron")
        return true
      }
      cursor -= 60_000
    }
    return false
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
      agent: ctx.agentName,
      channel: this.name,
      entryId: entry.id,
      entryName: entry.name,
      runAt: entry.runAt,
      kind,
    })

    const threadKey = `schedule:${entry.id}`
    const text = formatPrompt(this.name, entry)
    ctx.onLog(`[${this.name}] firing ${entry.name} (${kind})`)

    const reply = await ctx.runTextTurn(threadKey, text)
    const turnFailed = reply instanceof Error
    if (turnFailed) {
      ctx.onLog(`[${this.name}] entry ${entry.name} turn failed: ${reply.message}`)
    }

    if (kind === "cron") {
      // Only advance `lastFiredAt` on success. If the turn failed, leaving the
      // mark stale keeps the failure visible to the catch-up window on the
      // next daemon start instead of silently masking a broken cron.
      if (!turnFailed) {
        try {
          this.props.store.markFired(entry.id, Date.now())
        } catch (err) {
          ctx.onLog(
            `[${this.name}] entry ${entry.name} fired but failed to mark: ${errorMessage(err)}`,
          )
        }
      }
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

const decideFire = (
  entry: ScheduleEntry,
  now: Date,
  ctx: ChannelPluginContext,
): "cron" | "one-shot" | "skip" => {
  if (looksLikeCron(entry.runAt)) {
    let expr: ReturnType<typeof parseCronExpression>
    try {
      expr = parseCronExpression(entry.runAt)
    } catch (err) {
      ctx.onLog(
        `[schedule] entry ${entry.name} has bad cron '${entry.runAt}': ${errorMessage(err)}`,
      )
      return "skip"
    }
    return cronMatches(expr, now) ? "cron" : "skip"
  }

  const ts = Date.parse(entry.runAt)
  if (Number.isNaN(ts)) {
    ctx.onLog(`[schedule] entry ${entry.name} has unparseable runAt: '${entry.runAt}'`)
    return "skip"
  }
  return ts <= now.getTime() ? "one-shot" : "skip"
}

const formatPrompt = (channelName: string, entry: ScheduleEntry): string => {
  return [
    `<schedule channel="${channelName}" entry="${entry.name}" run-at="${entry.runAt}">`,
    entry.prompt,
    `</schedule>`,
  ].join("\n")
}
