import type {
  LeucoSlackEnvelope,
  LeucoSlackEventSource,
  LeucoSlackSourceLog,
  LeucoSlackSourceStatus,
} from "@/channels/slack/leuco-slack-event-source"
import type { LeucoSlackWebClient } from "@/channels/slack/leuco-slack-web-client"
import { LeucoSlackAdapter } from "@/channels/slack/slack-adapter"
import {
  LeucoSlackEventProcessor,
  type ProcessResult,
} from "@/channels/slack/slack-event-processor"
import type { SlackEvent, SlackMessageEvent } from "@/channels/slack/slack-types"
import { LeucoSlackXoxpPoller } from "@/channels/slack/leuco-slack-xoxp-poller"
import type { ChannelIdentity, ChannelPlugin, ChannelPluginContext } from "@/engine/channel-plugin"
import { errorMessage } from "@/error-message"

export type SlackAckMode = "off" | "mention" | "always"

export type SlackAckIcons = {
  progress: string
  success: string
  error: string
}

type Props = {
  name: string
  eventSource: LeucoSlackEventSource
  webClient: LeucoSlackWebClient
  /** True when the workspace gave the bot a user token (`xoxp-`) instead of a
   * bot token (`xoxb-`). Drives the xoxp poller for `app_mention` parity. */
  usesUserToken: boolean
  /** When the bot adds the in-progress / done / error reactions. Defaults to "mention". */
  ackMode?: SlackAckMode
  /** Override the emoji names used for ack reactions. */
  ackIcons?: SlackAckIcons
}

const DEFAULT_ACK_ICONS: SlackAckIcons = {
  progress: "hourglass_flowing_sand",
  success: "white_check_mark",
  error: "x",
}

const STATUS_REPLY_DELAY_MS = 20 * 1000
const STATUS_REPLY_TEXT = "見てます。少し待ってください。"
const TIMEOUT_REPLY_TEXT =
  "遅れてすみません。処理が詰まったので立て直しました。もう一度メンションしてください。"
const ACTIVE_THREAD_CAPACITY = 500
const SOCKET_EVENT_START_GRACE_MS = 30_000

/**
 * Bridges a single Slack workspace to the engine. Subscribes to inbound
 * Socket Mode envelopes through `LeucoSlackEventSource`, routes
 * `payload.event.type` into the pure `LeucoSlackEventProcessor`, and forwards
 * each accepted `message` event to the agent through `ctx.runTextTurn`,
 * wrapped in a structured envelope so the agent has the metadata it needs to
 * decide whether to reply. If the agent returns empty text, the plugin posts
 * nothing. Reactions are emitted to the bus for telemetry only and never
 * trigger an agent turn.
 */
export class LeucoSlackChannelPlugin implements ChannelPlugin {
  readonly name: string
  private readonly props: Props
  private adapter: LeucoSlackAdapter | null = null
  private processor: LeucoSlackEventProcessor
  private xoxpPoller: LeucoSlackXoxpPoller | null = null
  private ctx: ChannelPluginContext | null = null
  private botUserId: string | null = null
  private lastConnectionStatus: LeucoSlackSourceStatus | null = null
  private readonly socketEventOldest = socketEventStartOldest()
  private readonly activeThreads = new Map<string, number>()

  constructor(props: Props) {
    this.name = props.name
    this.props = props
    // Wire the processor at construction so events arriving during the
    // `start()` → `authTest()` window don't drop. The botUserId starts null
    // (self/bot filters skip those events until known) and is upgraded once
    // auth.test resolves.
    this.processor = new LeucoSlackEventProcessor({ botUserId: null })
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx
    this.adapter = new LeucoSlackAdapter({ client: this.props.webClient, onLog: ctx.onLog })

    ctx.onLog(`[${this.name}] resolving bot identity via auth.test`)
    this.botUserId = await this.fetchBotUserId()
    this.processor.setBotUserId(this.botUserId)

    if (this.botUserId === null) {
      throw new Error(
        `slack channel '${this.name}': auth.test did not resolve a bot user id — all messages would be silently dropped`,
      )
    }

    if (this.props.usesUserToken) {
      this.xoxpPoller = new LeucoSlackXoxpPoller({
        client: this.props.webClient,
        botUserId: this.botUserId,
        dispatchMessage: (raw) => this.dispatchRawMessage(raw),
        rememberActiveThread: (channel, threadTs) => this.rememberActiveThread(channel, threadTs),
        onLog: (line) => ctx.onLog(`[${this.name}] ${line}`),
      })
    }

    ctx.onLog(`[${this.name}] connecting to Slack (Socket Mode)`)
    await this.props.eventSource.start({
      onEvent: (envelope) => this.handleEnvelope(envelope),
      onStatus: (status) => this.handleStatus(status),
      onLog: (log) => this.handleSourceLog(log),
    })

    if (this.xoxpPoller !== null) this.xoxpPoller.start()

    const who = this.botUserId !== null ? `<@${this.botUserId}>` : "(bot)"
    ctx.onLog(`[${this.name}] ready — forwarding messages to agent (bot=${who})`)
  }

  async stop(): Promise<void> {
    if (this.xoxpPoller !== null) this.xoxpPoller.stop()
    this.xoxpPoller = null
    await this.props.eventSource.stop()
    this.adapter = null
    this.ctx = null
    this.botUserId = null
    this.lastConnectionStatus = null
  }

  getIdentity(): ChannelIdentity {
    return { name: this.name, type: "slack", botUserId: this.botUserId }
  }

  /** Live socket-mode connection status. Read on demand (e.g. from CLI /
   * health-check routes). Status transitions are also emitted as
   * `slack.connection` events on the bus — this getter is the synchronous
   * point read on top of that. */
  getConnectionStatus(): LeucoSlackSourceStatus {
    return this.props.eventSource.status()
  }

  private async fetchBotUserId(): Promise<string | null> {
    try {
      const result = await this.props.webClient.authTest()
      return result.userId
    } catch (err) {
      this.emitAuthFailure(err)
      return null
    }
  }

  private emitAuthFailure(err: unknown): void {
    const ctx = this.ctx
    if (ctx === null) return
    const message = errorMessage(err)
    ctx.bus.emit({
      ts: Date.now(),
      type: "slack.error",
      project: ctx.projectName,
      channel: this.name,
      level: "error",
      action: "auth.test",
      message: "auth.test failed; bot identity unknown",
      error: message,
    })
  }

  private async handleEnvelope(envelope: LeucoSlackEnvelope): Promise<void> {
    if (envelope.type !== "events_api") return

    const rawEvent = envelope.payload.event
    if (typeof rawEvent !== "object" || rawEvent === null) return

    if (this.shouldDropStaleSocketEvent(rawEvent)) return

    const eventType = (rawEvent as { type?: unknown }).type

    if (eventType === "app_mention") {
      await this.dispatchResult(this.processor.processAppMention(rawEvent))
      return
    }

    if (eventType === "message") {
      this.recordActiveThreadFromRawMessage(rawEvent)
      await this.dispatchResult(
        this.withActiveThreadContext(this.processor.processMessage(rawEvent)),
      )
      return
    }

    if (eventType === "reaction_added" || eventType === "reaction_removed") {
      await this.dispatchResult(this.processor.processReaction(rawEvent))
      return
    }
  }

  private handleStatus(status: LeucoSlackSourceStatus): void {
    const ctx = this.ctx
    if (ctx === null) return
    // Suppress flapping during reconnect storms — flume cycles through the
    // same intermediate states many times per minute when Slack is unhappy
    // and the bus would otherwise drown out the events worth alerting on.
    if (this.lastConnectionStatus === status) return
    this.lastConnectionStatus = status
    ctx.bus.emit({
      ts: Date.now(),
      type: "slack.connection",
      project: ctx.projectName,
      channel: this.name,
      status,
    })
  }

  private handleSourceLog(log: LeucoSlackSourceLog): void {
    const ctx = this.ctx
    if (ctx === null) return

    if (log.level === "warn" || log.level === "error") {
      ctx.bus.emit({
        ts: Date.now(),
        type: "slack.error",
        project: ctx.projectName,
        channel: this.name,
        level: log.level,
        action: log.action,
        message: log.message,
        error: log.error !== null ? log.error.message : null,
      })
      return
    }

    if (log.level === "debug") return
    ctx.onLog(`[${this.name}] slack ${log.level} ${log.action}: ${log.message}`)
  }

  private shouldDropStaleSocketEvent(event: unknown): boolean {
    const ts = slackEventTimestamp(event)
    if (ts === null || ts >= this.socketEventOldest) return false
    this.ctx?.onLog(
      `[${this.name}] skip stale socket event ts=${ts.toFixed(6)} oldest=${this.socketEventOldest.toFixed(6)}`,
    )
    return true
  }

  private async dispatchRawMessage(raw: {
    channel: string
    user: string | null
    text: string | null
    ts: string
    threadTs: string | null
    subtype: string | null
    botId: string | null
  }): Promise<void> {
    const slackEvent: Record<string, unknown> = {
      type: "message",
      channel: raw.channel,
      ts: raw.ts,
    }
    if (raw.user !== null) slackEvent.user = raw.user
    if (raw.text !== null) slackEvent.text = raw.text
    if (raw.threadTs !== null) slackEvent.thread_ts = raw.threadTs
    if (raw.subtype !== null) slackEvent.subtype = raw.subtype
    if (raw.botId !== null) slackEvent.bot_id = raw.botId

    await this.dispatchResult(
      this.withActiveThreadContext(this.processor.processMessage(slackEvent)),
    )
  }

  private async dispatchResult(result: ProcessResult): Promise<void> {
    if (result.skip) {
      this.ctx?.onLog(`[${this.name}] ${result.reason}`)
      return
    }
    this.ctx?.onLog(`[${this.name}] ${formatDispatch(result.event)}`)
    await this.handleEvent(result.event)
  }

  private async handleEvent(event: SlackEvent): Promise<void> {
    const ctx = this.ctx
    const adapter = this.adapter

    if (adapter && isConversationChannel(event.channel)) {
      const canRead = await adapter.canReadChannel(event.channel)
      if (!canRead) {
        ctx?.onLog(`[${this.name}] drop inaccessible slack event channel=${event.channel}`)
        return
      }
    }

    if (ctx) {
      ctx.bus.emit({
        ts: Date.now(),
        type: "slack.event",
        project: ctx.projectName,
        channel: event.channel,
        event,
      })
    }

    // Reactions (including the bot's own ack hourglass / checkmark) are
    // surfaced to the bus for telemetry only — never to a codex turn. Letting
    // them through would loop the agent on every ack it just placed.
    if (event.kind !== "message") return

    await this.handleMessage(event)
  }

  /**
   * Run a turn for the message but never post the codex reply text directly.
   * The model's `runTextTurn` return value is internal monologue — to surface
   * anything to Slack the agent must call the `slack_call` MCP tool itself.
   * This plugin only adds the small visible signals that don't compose well
   * as tool calls: the progress/success/error reactions and a turn-failed
   * `:x:` so the human can see something went wrong even if codex never
   * spoke up.
   */
  private async handleMessage(msg: SlackMessageEvent): Promise<void> {
    const ctx = this.ctx
    const adapter = this.adapter
    if (!ctx || !adapter) return

    const threadKey = `${this.name}:${msg.channel}:${msg.threadTs}`
    const reactionTs = msg.ts
    const wantsAck = this.shouldAck(msg)
    const wantsStatusReply = this.shouldSendStatusReply(msg)
    const icons = this.props.ackIcons ?? DEFAULT_ACK_ICONS
    let turnDone = false
    let statusReplyPosted = false
    let statusReplyTimer: ReturnType<typeof setTimeout> | null = null

    if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.progress)
    if (wantsStatusReply) {
      statusReplyTimer = setTimeout(() => {
        void (async () => {
          if (turnDone) return
          if (await this.hasVisibleBotReplyAfter(msg)) return
          if (turnDone) return
          statusReplyPosted = await this.postReplySafely(msg, STATUS_REPLY_TEXT)
        })()
      }, STATUS_REPLY_DELAY_MS)
      unrefTimer(statusReplyTimer)
    }

    const monologue = await ctx.runTextTurn(threadKey, formatMessageInput(this.name, msg))
    turnDone = true
    if (statusReplyTimer) clearTimeout(statusReplyTimer)
    if (monologue instanceof Error) {
      ctx.onLog(`[${this.name}] turn failed: ${monologue.message}`)
      if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.error)
      if (wantsStatusReply) await this.postTimeoutReplyIfNeeded(msg, statusReplyPosted)
    } else {
      logMonologue(ctx.onLog, this.name, msg.ts, monologue)
      if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.success)
    }

    if (wantsAck) {
      await adapter.removeReaction(msg.channel, reactionTs, icons.progress)
    }
  }

  private shouldAck(msg: SlackMessageEvent): boolean {
    const mode = this.props.ackMode ?? "mention"
    if (mode === "off") return false
    if (mode === "always") return true
    return msg.mentioned
  }

  private shouldSendStatusReply(msg: SlackMessageEvent): boolean {
    return msg.mentioned || msg.channel.startsWith("D")
  }

  private async hasVisibleBotReplyAfter(
    msg: SlackMessageEvent,
    ignoredTexts: readonly string[] = [],
  ): Promise<boolean> {
    if (!this.adapter || this.botUserId === null) return false
    return this.adapter.hasBotReplyAfter(msg.channel, msg.threadTs, msg.ts, this.botUserId, {
      ignoredTexts,
    })
  }

  private async postTimeoutReplyIfNeeded(
    msg: SlackMessageEvent,
    statusReplyPosted: boolean,
  ): Promise<void> {
    if (!this.adapter) return
    const ignoredTexts = statusReplyPosted ? [STATUS_REPLY_TEXT] : []
    if (await this.hasVisibleBotReplyAfter(msg, ignoredTexts)) return
    await this.postReplySafely(msg, TIMEOUT_REPLY_TEXT)
  }

  private async postReplySafely(msg: SlackMessageEvent, text: string): Promise<boolean> {
    if (!this.adapter || !this.ctx) return false
    try {
      await this.adapter.postReply({
        channel: msg.channel,
        threadTs: msg.threadTs,
        text,
      })
      return true
    } catch (err) {
      this.ctx.onLog(`[${this.name}] status reply failed: ${errorMessage(err)}`)
      return false
    }
  }

  private recordActiveThreadFromRawMessage(message: unknown): void {
    if (this.botUserId === null) return
    if (typeof message !== "object" || message === null) return
    const data = message as {
      channel?: unknown
      user?: unknown
      ts?: unknown
      thread_ts?: unknown
    }
    if (data.user !== this.botUserId) return
    if (typeof data.channel !== "string" || typeof data.ts !== "string") return
    const threadTs = typeof data.thread_ts === "string" ? data.thread_ts : data.ts
    this.rememberActiveThread(data.channel, threadTs)
  }

  private withActiveThreadContext(result: ProcessResult): ProcessResult {
    if (result.skip || result.event.kind !== "message") return result
    if (!this.activeThreads.has(activeThreadKey(result.event.channel, result.event.threadTs))) {
      return result
    }
    return {
      skip: false,
      event: { ...result.event, mentioned: true },
    }
  }

  private rememberActiveThread(channel: string, threadTs: string): void {
    const key = activeThreadKey(channel, threadTs)
    this.activeThreads.delete(key)
    this.activeThreads.set(key, Date.now())
    while (this.activeThreads.size > ACTIVE_THREAD_CAPACITY) {
      const oldest = this.activeThreads.keys().next().value
      if (typeof oldest !== "string") break
      this.activeThreads.delete(oldest)
    }
  }
}

const isConversationChannel = (channel: string): boolean => /^[CDG]/.test(channel)

const activeThreadKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`

const socketEventStartOldest = (): number => {
  return (Date.now() - SOCKET_EVENT_START_GRACE_MS) / 1000
}

const slackEventTimestamp = (event: unknown): number | null => {
  if (typeof event !== "object" || event === null) return null
  const raw =
    (event as { ts?: unknown; event_ts?: unknown }).ts ?? (event as { event_ts?: unknown }).event_ts
  if (typeof raw !== "string" && typeof raw !== "number") return null
  const ts = Number(raw)
  return Number.isFinite(ts) ? ts : null
}

const formatDispatch = (event: SlackEvent): string => {
  if (event.kind === "message") {
    return `dispatch ${event.source} channel=${event.channel} ts=${event.ts}${event.mentioned ? " mentioned" : ""}`
  }
  return `dispatch ${event.kind} channel=${event.channel} target_ts=${event.targetTs} :${event.emoji}: by=${event.user}`
}

const formatMessageInput = (channelName: string, msg: SlackMessageEvent): string => {
  return [
    `<slack-event channel-config="${attr(channelName)}" channel="${attr(msg.channel)}" user="${attr(msg.user)}" ts="${attr(msg.ts)}" thread_ts="${attr(msg.threadTs)}" mentioned="${msg.mentioned}" source="${msg.source}">`,
    escapeEnvelopeBody(msg.text),
    `</slack-event>`,
  ].join("\n")
}

/** Minimal XML attribute escape. Slack IDs / ts are normally safe but a
 * channel name set by the user could contain `"`. */
const attr = (value: string): string => {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/** Defang any literal `</slack-event>` inside the body so a crafted message
 * cannot inject extra envelopes the model would see as separate events
 * (prompt-injection vector). The replacement is visible and self-explanatory
 * so the human reading the log understands the substitution. */
const escapeEnvelopeBody = (text: string): string => {
  return text.replace(/<\/slack-event>/gi, "&lt;/slack-event&gt;")
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  const maybeUnref = (timer as { unref?: () => void }).unref
  if (typeof maybeUnref === "function") maybeUnref.call(timer)
}

const MONOLOGUE_LOG_LIMIT = 200

const logMonologue = (
  onLog: (line: string) => void,
  pluginName: string,
  ts: string,
  monologue: string,
): void => {
  const trimmed = monologue.trim()
  if (trimmed.length === 0) {
    onLog(`[${pluginName}] agent silent (msg ts=${ts})`)
    return
  }
  const preview =
    trimmed.length <= MONOLOGUE_LOG_LIMIT
      ? trimmed
      : `${trimmed.slice(0, MONOLOGUE_LOG_LIMIT - 1)}…`
  onLog(`[${pluginName}] monologue (msg ts=${ts}): ${preview}`)
}
