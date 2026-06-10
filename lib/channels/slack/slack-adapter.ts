import { WebClient } from "@slack/web-api"
import type { SlackReply } from "@/channels/slack/slack-types"
import type { WebClientPort } from "@/channels/slack/web-client-port"
import { errorMessage } from "@/error-message"

type Props = {
  client: WebClientPort
  onLog?: (line: string) => void
}

/** Thin wrapper around `chat.postMessage` for thread replies and ephemeral status updates. */
export class LeucoSlackAdapter {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  static fromBotToken(botToken: string, onLog?: (line: string) => void): LeucoSlackAdapter {
    return new LeucoSlackAdapter({ client: new WebClient(botToken), onLog })
  }

  async postReply(reply: SlackReply): Promise<void> {
    await this.props.client.chat.postMessage({
      channel: reply.channel,
      thread_ts: reply.threadTs,
      text: reply.text,
    })
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.props.client.reactions.add({ channel, timestamp: ts, name })
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
      await this.props.client.reactions.remove({ channel, timestamp: ts, name })
    } catch (err) {
      this.logReactionFailure("remove", channel, ts, name, err)
    }
  }

  async canReadChannel(channel: string): Promise<boolean> {
    try {
      const info = await this.props.client.conversations.info({ channel })
      if (isPublicChannel(channel) && conversationIsNonMember(info)) {
        if (this.props.onLog) {
          this.props.onLog(
            `[slack] conversations.info says bot is not a channel member (channel=${channel})`,
          )
        }
        return false
      }
      return true
    } catch (err) {
      if (this.props.onLog) {
        this.props.onLog(
          `[slack] conversations.info failed (channel=${channel}): ${errorMessage(err)}`,
        )
      }
      return false
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

const conversationIsNonMember = (info: unknown): boolean => {
  if (typeof info !== "object" || info === null) return false
  const channel = (info as { channel?: unknown }).channel
  if (typeof channel !== "object" || channel === null) return false
  return (channel as { is_member?: unknown }).is_member === false
}
