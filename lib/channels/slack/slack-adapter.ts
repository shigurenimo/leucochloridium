import type { LeucoSlackWebClient } from "@/channels/slack/leuco-slack-web-client"
import type { SlackReply } from "@/channels/slack/slack-types"
import { errorMessage } from "@/error-message"

type Props = {
  client: LeucoSlackWebClient
  onLog?: (line: string) => void
}

/** Thin wrapper around the outbound Slack Web API surface the channel plugin
 * actually needs (reply, reaction, accessibility check). */
export class LeucoSlackAdapter {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  async postReply(reply: SlackReply): Promise<void> {
    await this.props.client.chatPostMessage({
      channel: reply.channel,
      threadTs: reply.threadTs,
      text: reply.text,
    })
  }

  async hasBotReplyAfter(
    channel: string,
    threadTs: string,
    messageTs: string,
    botUserId: string,
    options: { ignoredTexts?: readonly string[] } = {},
  ): Promise<boolean> {
    try {
      const result = await this.props.client.conversationsReplies({
        channel,
        ts: threadTs,
        oldest: messageTs,
        inclusive: false,
        limit: 100,
      })
      const ignoredTexts = new Set((options.ignoredTexts ?? []).map((text) => text.trim()))

      return result.messages.some((message) => {
        if (message.user !== botUserId) return false
        const text = message.text ?? ""
        if (ignoredTexts.has(text.trim())) return false
        return true
      })
    } catch (err) {
      if (this.props.onLog) {
        this.props.onLog(
          `[slack] conversations.replies failed (channel=${channel} ts=${threadTs}): ${errorMessage(err)}`,
        )
      }
      return false
    }
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.props.client.reactionsAdd({ channel, timestamp: ts, name })
    } catch (err) {
      // Idempotent reactions (`already_reacted`) are expected; everything else
      // (invalid_auth, channel_not_found, account_inactive, ratelimited, …)
      // is surfaced so a silently-revoked bot token doesn't manifest as the
      // ack icons just quietly disappearing.
      this.logReactionFailure("add", channel, ts, name, err)
    }
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.props.client.reactionsRemove({ channel, timestamp: ts, name })
    } catch (err) {
      this.logReactionFailure("remove", channel, ts, name, err)
    }
  }

  async canReadChannel(channel: string): Promise<boolean> {
    try {
      const info = await this.props.client.conversationsInfo({ channel })
      if (isPublicChannel(channel) && info.isMember === false) {
        if (this.props.onLog) {
          this.props.onLog(
            `[slack] conversations.info says bot is not a channel member (channel=${channel})`,
          )
        }
        return false
      }
      return true
    } catch (err) {
      const message = errorMessage(err)
      if (this.props.onLog) {
        this.props.onLog(`[slack] conversations.info failed (channel=${channel}): ${message}`)
      }
      // Only treat known access-denied errors as a hard "skip this event".
      // Transient errors (rate-limited, network blip, Slack 5xx) must NOT
      // silently drop the inbound event — otherwise a brief Slack outage
      // turns into universal "the bot ignored my mention".
      if (isPermanentChannelDenial(message)) return false
      return true
    }
  }

  private logReactionFailure(
    op: "add" | "remove",
    channel: string,
    ts: string,
    name: string,
    err: unknown,
  ): void {
    if (!this.props.onLog) return
    const message = errorMessage(err)
    if (/already_reacted|no_reaction|message_not_found/i.test(message)) return
    this.props.onLog(
      `[slack] reactions.${op} failed (channel=${channel} ts=${ts} :${name}:): ${message}`,
    )
  }
}

const isPublicChannel = (channel: string): boolean => channel.startsWith("C")

// Slack returns these error strings in the `error` field of the JSON envelope
// when the bot genuinely cannot read the channel; the fetch client surfaces
// them through `Error("slack <method>: <reason>")`. Anything else (network
// failures, ratelimits, 5xx) we treat as transient and let the event through
// — losing one mention to a flaky `conversations.info` is worse than letting
// the agent decide whether to reply.
const isPermanentChannelDenial = (message: string): boolean => {
  return /channel_not_found|is_archived|missing_scope|not_authed|account_inactive|access_denied|not_in_channel|invalid_channel/i.test(
    message,
  )
}
