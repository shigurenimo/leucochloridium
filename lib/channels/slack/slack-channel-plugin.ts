import { LeucoSlackAdapter } from "@/channels/slack/slack-adapter"
import { LeucoSlackListener } from "@/channels/slack/slack-listener"
import type { SlackEvent, SlackMessageEvent } from "@/channels/slack/slack-types"
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
  botToken: string
  appToken: string
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

/**
 * Bridges a single Slack workspace to the engine. Forwards every accepted
 * `message` event (no mention gating, no thread-active state) to the agent
 * through `ctx.runTextTurn`, wrapped in a structured envelope so the agent
 * has the metadata it needs to decide whether to reply. If the agent returns
 * empty text, the plugin posts nothing. Reactions are emitted to the bus for
 * telemetry only and never trigger an agent turn — see `handleEvent`.
 */
export class LeucoSlackChannelPlugin implements ChannelPlugin {
  readonly name: string
  private readonly props: Props
  private listener: LeucoSlackListener | null = null
  private adapter: LeucoSlackAdapter | null = null
  private ctx: ChannelPluginContext | null = null
  private botUserId: string | null = null

  constructor(props: Props) {
    this.name = props.name
    this.props = props
  }

  async start(ctx: ChannelPluginContext): Promise<void> {
    this.ctx = ctx
    this.adapter = LeucoSlackAdapter.fromBotToken(this.props.botToken)
    this.listener = new LeucoSlackListener({
      botToken: this.props.botToken,
      appToken: this.props.appToken,
      onLog: ctx.onLog,
    })

    this.listener.onEvent((event) => this.handleEvent(event))

    ctx.onLog(`[${this.name}] connecting to Slack (Socket Mode)`)
    const started = await this.listener.start()
    this.botUserId = started.botUserId
    const who = started.botUserId ? `<@${started.botUserId}>` : "(bot)"
    ctx.onLog(`[${this.name}] ready — forwarding messages to agent (bot=${who})`)
  }

  async stop(): Promise<void> {
    if (this.listener) await this.listener.stop()
    this.listener = null
    this.adapter = null
    this.ctx = null
    this.botUserId = null
  }

  getIdentity(): ChannelIdentity {
    return { name: this.name, type: "slack", botUserId: this.botUserId }
  }

  private async handleEvent(event: SlackEvent): Promise<void> {
    const ctx = this.ctx
    if (ctx) {
      ctx.bus.emit({
        ts: Date.now(),
        type: "slack.event",
        project: ctx.projectName,
        agent: ctx.agentName,
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

  private async handleMessage(msg: SlackMessageEvent): Promise<void> {
    const ctx = this.ctx
    const adapter = this.adapter
    if (!ctx || !adapter) return

    const threadKey = `${this.name}:${msg.channel}:${msg.threadTs}`
    const reactionTs = msg.ts
    const wantsAck = this.shouldAck(msg)
    const icons = this.props.ackIcons ?? DEFAULT_ACK_ICONS

    if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.progress)

    try {
      const reply = await ctx.runTextTurn(threadKey, formatMessageInput(this.name, msg))
      const text = reply.trim()

      if (text.length === 0) {
        ctx.onLog(`[${this.name}] agent silent (msg ts=${msg.ts})`)
        if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.success)
        return
      }

      await adapter.postReply({ channel: msg.channel, threadTs: msg.threadTs, text })
      if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.success)
    } catch (err) {
      const message = errorMessage(err)
      ctx.onLog(`[${this.name}] turn failed: ${message}`)
      await adapter.postReply({
        channel: msg.channel,
        threadTs: msg.threadTs,
        text: `⚠️ ${message}`,
      })
      if (wantsAck) await adapter.addReaction(msg.channel, reactionTs, icons.error)
    } finally {
      if (wantsAck) {
        await adapter.removeReaction(msg.channel, reactionTs, icons.progress)
      }
    }
  }

  private shouldAck(msg: SlackMessageEvent): boolean {
    const mode = this.props.ackMode ?? "mention"
    if (mode === "off") return false
    if (mode === "always") return true
    return msg.mentioned
  }
}

const formatMessageInput = (channelName: string, msg: SlackMessageEvent): string => {
  return [
    `<slack-event channel-config="${channelName}" channel="${msg.channel}" user="${msg.user}" ts="${msg.ts}" thread_ts="${msg.threadTs}" mentioned="${msg.mentioned}" source="${msg.source}">`,
    msg.text,
    `</slack-event>`,
  ].join("\n")
}
