import type { LeucoSlackWebClient } from "@/channels/slack/leuco-slack-web-client"
import type { SlackReply } from "@/channels/slack/slack-types"
import { errorMessage } from "@/error-message"

export type LeucoSlackAdapterProps = {
  client: LeucoSlackWebClient
  onLog?: (line: string) => void
}

/** Thin wrapper around the outbound Slack Web API surface the channel plugin
 * actually needs (reply, reaction, and reply-history checks). */
export class LeucoSlackAdapter {
  constructor(private readonly props: LeucoSlackAdapterProps) {
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
      // A failed history lookup cannot prove that a reply exists. Returning
      // true here silently discarded a generated final answer and still let
      // the plugin mark the turn successful. Prefer a possible duplicate over
      // losing the only user-visible answer.
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
