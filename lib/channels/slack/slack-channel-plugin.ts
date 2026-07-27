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
import type {
  ChannelIdentity,
  ChannelPlugin,
  ChannelPluginContext,
} from "@/channels/channel-plugin"
import { errorMessage } from "@/error-message"

export type SlackAckMode = "off" | "mention" | "always"

export type SlackAckIcons = {
  progress: string
  success: string
  error: string
}

export type LeucoSlackChannelPluginProps = {
  name: string
  eventSource: LeucoSlackEventSource
  webClient: LeucoSlackWebClient
  /** True when the workspace gave the bot a user token (`xoxp-`) instead of a
   * bot token (`xoxb-`). Used only for diagnostics; inbound delivery must
   * come from Socket Mode, not Web API history polling. */
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

const ACTIVE_THREAD_CAPACITY = 500

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
  private readonly props: LeucoSlackChannelPluginProps
  private adapter: LeucoSlackAdapter | null = null
  private processor: LeucoSlackEventProcessor
  private ctx: ChannelPluginContext | null = null
  private botUserId: string | null = null
  private lastConnectionStatus: LeucoSlackSourceStatus | null = null
  private readonly activeThreads = new Map<string, number>()
  private lifecycleGeneration = 0
  private activeGeneration: number | null = null
  private readonly inFlightHandlers = new Map<number, Set<Promise<void>>>()
  private stopPromise: Promise<void> | null = null

  constructor(props: LeucoSlackChannelPluginProps) {
    this.name = props.name
    this.props = props
    // Wire the processor at construction. Events cannot arrive before
    // `start()` resolves auth.test (the event source is only started after),
    // but if that ordering ever changes note that a null botUserId does NOT
    // queue events — the processor skips them with "botUserId unknown".
    this.processor = new LeucoSlackEventProcessor({ botUserId: null })
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    if (this.activeGeneration !== null || this.stopPromise !== null) {
      throw new Error(`slack channel '${this.name}' is already started or stopping`)
    }

    const generation = this.lifecycleGeneration + 1
    this.lifecycleGeneration = generation
    this.activeGeneration = generation
    this.ctx = ctx
    this.adapter = new LeucoSlackAdapter({ client: this.props.webClient, onLog: ctx.onLog })

    try {
      await this.startGeneration(ctx, generation)
    } catch (err) {
      await this.abortGeneration(generation, ctx)
      throw err
    }
  }

  stop(): Promise<void> {
    const currentStop = this.stopPromise
    if (currentStop !== null) return currentStop

    const generation = this.activeGeneration
    this.activeGeneration = null
    const stopPromise = this.stopGeneration(generation)
    this.stopPromise = stopPromise
    const clearStop = (): void => {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    }
    void stopPromise.then(clearStop, clearStop)
    return stopPromise
  }

  private async stopGeneration(generation: number | null): Promise<void> {
    try {
      await this.props.eventSource.stop()
    } finally {
      if (generation !== null) await this.drainGeneration(generation)
      this.clearGeneration(generation)
    }
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

  private async startGeneration(ctx: ChannelPluginContext, generation: number): Promise<void> {
    ctx.onLog(`[${this.name}] resolving bot identity via auth.test`)
    const botUserId = await this.fetchBotUserId(generation)
    this.ensureGenerationIsActive(generation)
    this.botUserId = botUserId
    this.processor.setBotUserId(botUserId)

    if (botUserId === null) {
      throw new Error(
        `slack channel '${this.name}': auth.test did not resolve a bot user id — all messages would be silently dropped`,
      )
    }

    this.logUserToken(ctx)
    await this.startEventSource(ctx, generation)
    this.ensureGenerationIsActive(generation)
    ctx.onLog(`[${this.name}] ready — forwarding messages to agent (bot=<@${botUserId}>)`)
  }

  private async fetchBotUserId(generation: number): Promise<string | null> {
    try {
      const result = await this.props.webClient.authTest()
      return result.userId
    } catch (err) {
      this.emitAuthFailure(err, generation)
      return null
    }
  }

  private emitAuthFailure(err: unknown, generation: number): void {
    if (!this.isGenerationActive(generation)) return
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

  private logUserToken(ctx: ChannelPluginContext): void {
    if (!this.props.usesUserToken) return
    ctx.onLog(
      `[${this.name}] using xoxp token for Slack Web API; inbound events are Socket Mode only`,
    )
  }

  private async startEventSource(ctx: ChannelPluginContext, generation: number): Promise<void> {
    ctx.onLog(`[${this.name}] connecting to Slack (Socket Mode)`)
    await this.props.eventSource.start({
      onEvent: (envelope) => this.trackEnvelope(envelope, generation),
      onStatus: (status) => this.handleStatus(status, generation),
      onLog: (log) => this.handleSourceLog(log, generation),
    })
  }

  private async abortGeneration(generation: number, ctx: ChannelPluginContext): Promise<void> {
    if (this.activeGeneration === generation) this.activeGeneration = null
    await this.props.eventSource.stop().catch((err: unknown) => {
      ctx.onLog(`[${this.name}] failed to close aborted Slack source: ${errorMessage(err)}`)
    })
    await this.drainGeneration(generation)
    this.clearGeneration(generation)
  }

  private async handleEnvelope(envelope: LeucoSlackEnvelope, generation: number): Promise<void> {
    if (!this.isGenerationActive(generation)) return
    if (envelope.type !== "events_api") return

    const rawEvent = envelope.payload.event
    if (typeof rawEvent !== "object" || rawEvent === null) return

    const eventType = (rawEvent as { type?: unknown }).type

    if (eventType === "app_mention") {
      await this.dispatchResult(this.processor.processAppMention(rawEvent), generation)
      return
    }

    if (eventType === "message") {
      this.recordActiveThreadFromRawMessage(rawEvent)
      await this.dispatchResult(
        this.withActiveThreadContext(this.processor.processMessage(rawEvent)),
        generation,
      )
      return
    }

    if (eventType === "reaction_added" || eventType === "reaction_removed") {
      await this.dispatchResult(this.processor.processReaction(rawEvent), generation)
      return
    }
  }

  private handleStatus(status: LeucoSlackSourceStatus, generation: number): void {
    if (!this.isGenerationActive(generation)) return
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

  private handleSourceLog(log: LeucoSlackSourceLog, generation: number): void {
    if (!this.isGenerationActive(generation)) return
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
      // Also surface on the diagnostic log stream so `leuco logs -f` shows
      // socket-mode failures in real time — events.db alone is invisible to
      // anyone tailing the log without knowing to also query the bus.
      ctx.onLog(`[${this.name}] slack ${log.level} ${log.action}: ${log.message}`)
      return
    }

    if (log.level === "debug") return
    ctx.onLog(`[${this.name}] slack ${log.level} ${log.action}: ${log.message}`)
  }

  private async dispatchResult(result: ProcessResult, generation: number): Promise<void> {
    if (!this.isGenerationActive(generation)) return
    if (result.skip) {
      this.ctx?.onLog(`[${this.name}] ${result.reason}`)
      return
    }
    this.ctx?.onLog(`[${this.name}] ${formatDispatch(result.event)}`)
    await this.handleEvent(result.event, generation)
  }

  private async handleEvent(event: SlackEvent, generation: number): Promise<void> {
    if (!this.isGenerationActive(generation)) return
    const ctx = this.ctx

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

    await this.handleMessage(event, generation)
  }

  /**
   * Prefer explicit `slack_call` writes, but do not discard a real final
   * answer to an addressed message. If Codex completed with final text and
   * no bot reply is visible, post that exact generated text as a fallback.
   * Errors remain reaction/event-only; no canned failure copy is synthesized.
   */
  private async handleMessage(msg: SlackMessageEvent, generation: number): Promise<void> {
    if (!this.isGenerationActive(generation)) return
    const ctx = this.ctx
    const adapter = this.adapter
    if (!ctx || !adapter) return

    const threadKey = `${this.name}:${msg.channel}:${msg.threadTs}`
    const reactionTs = msg.ts
    const wantsAck = this.shouldAck(msg)
    const icons = this.props.ackIcons ?? DEFAULT_ACK_ICONS

    try {
      if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.progress)
      if (!this.isGenerationActive(generation)) return

      const monologue = await ctx.runTextTurn(threadKey, formatMessageInput(this.name, msg), {
        priority: msg.mentioned ? "high" : "normal",
      })
      if (!this.isGenerationActive(generation)) return

      if (monologue instanceof Error) {
        ctx.onLog(`[${this.name}] turn failed: ${monologue.message}`)
        ctx.bus.emit({
          ts: Date.now(),
          type: "slack.error",
          project: ctx.projectName,
          channel: this.name,
          level: "error",
          action: "turn.failed",
          message: `${msg.channel}/${msg.threadTs}: ${monologue.message}`,
          error: monologue.message,
        })
        if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.error)
      } else {
        logMonologue(ctx.onLog, this.name, msg.ts, monologue)
        const fallbackError = await this.postFinalAnswerIfNeeded(
          msg,
          monologue,
          adapter,
          generation,
        )
        if (!this.isGenerationActive(generation)) return

        if (fallbackError === null) {
          if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.success)
        } else {
          ctx.onLog(`[${this.name}] final answer post failed: ${fallbackError.message}`)
          ctx.bus.emit({
            ts: Date.now(),
            type: "slack.error",
            project: ctx.projectName,
            channel: this.name,
            level: "error",
            action: "final.post.failed",
            message: `${msg.channel}/${msg.threadTs}: ${fallbackError.message}`,
            error: fallbackError.message,
          })
          if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.error)
        }
      }
    } finally {
      // The adapter is captured from the generation that added this icon.
      // Cleanup must outlive the generation gate: stop() waits for accepted
      // handlers to drain, and leaving a stale hourglass makes a cancelled
      // turn look permanently stuck after restart.
      if (wantsAck) await adapter.removeReaction(msg.channel, reactionTs, icons.progress)
    }
  }

  private async postFinalAnswerIfNeeded(
    msg: SlackMessageEvent,
    finalText: string,
    adapter: LeucoSlackAdapter,
    generation: number,
  ): Promise<Error | null> {
    const text = finalText.trim()
    if (!msg.mentioned || text.length === 0 || this.botUserId === null) return null

    const alreadyReplied = await adapter.hasBotReplyAfter(
      msg.channel,
      msg.threadTs,
      msg.ts,
      this.botUserId,
    )
    if (alreadyReplied || !this.isGenerationActive(generation)) return null

    try {
      await adapter.postReply({
        channel: msg.channel,
        threadTs: msg.threadTs,
        text,
      })
      return null
    } catch (err) {
      return err instanceof Error ? err : new Error(errorMessage(err))
    }
  }

  private trackEnvelope(envelope: LeucoSlackEnvelope, generation: number): Promise<void> {
    if (!this.isGenerationActive(generation)) return Promise.resolve()
    const handlers = this.getGenerationHandlers(generation)
    const handler = this.handleEnvelope(envelope, generation)
    handlers.add(handler)
    const forget = (): void => this.forgetHandler(generation, handler)
    void handler.then(forget, forget)
    return handler
  }

  private getGenerationHandlers(generation: number): Set<Promise<void>> {
    const currentHandlers = this.inFlightHandlers.get(generation)
    if (currentHandlers !== undefined) return currentHandlers
    const handlers = new Set<Promise<void>>()
    this.inFlightHandlers.set(generation, handlers)
    return handlers
  }

  private forgetHandler(generation: number, handler: Promise<void>): void {
    const handlers = this.inFlightHandlers.get(generation)
    if (handlers === undefined) return
    handlers.delete(handler)
    if (handlers.size === 0) this.inFlightHandlers.delete(generation)
  }

  private async drainGeneration(generation: number): Promise<void> {
    const handlers = this.inFlightHandlers.get(generation)
    if (handlers === undefined) return
    await Promise.allSettled(Array.from(handlers))
    this.inFlightHandlers.delete(generation)
  }

  private clearGeneration(generation: number | null): void {
    if (this.activeGeneration !== null) return
    if (generation !== null && this.lifecycleGeneration !== generation) return
    this.adapter = null
    this.ctx = null
    this.botUserId = null
    this.processor.setBotUserId(null)
    this.lastConnectionStatus = null
  }

  private isGenerationActive(generation: number): boolean {
    return this.activeGeneration === generation
  }

  private ensureGenerationIsActive(generation: number): void {
    if (this.isGenerationActive(generation)) return
    throw new Error(`slack channel '${this.name}' start was cancelled`)
  }

  private shouldAck(msg: SlackMessageEvent): boolean {
    const mode = this.props.ackMode ?? "mention"
    if (mode === "off") return false
    if (mode === "always") return true
    return msg.mentioned
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

const activeThreadKey = (channel: string, threadTs: string): string => `${channel}:${threadTs}`

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

/** Defang any literal `<slack-event ...>` / `</slack-event>` inside the body
 * so a crafted message cannot inject extra envelopes the model would see as
 * separate events (prompt-injection vector). Opening tags matter as much as
 * closing ones: a fake opening tag combines with the real closing tag to
 * forge an envelope with attacker-controlled attributes. The replacement is
 * visible and self-explanatory so the human reading the log understands the
 * substitution. */
const escapeEnvelopeBody = (text: string): string => {
  return text
    .replace(/<slack-event/gi, "&lt;slack-event")
    .replace(/<\/slack-event>/gi, "&lt;/slack-event&gt;")
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
